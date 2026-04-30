/**
 * GitHub clone endpoint.
 *
 * POST /v1/github/clone
 * Auth: combinedAuth
 *
 * Clones a GitHub repo into the user's active sandbox at /workspace/<repo_name>.
 * Returns the cloned path + README summary for agent context injection.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { eq, desc } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { resolveAccountId } from '../shared/resolve-account';
import { config } from '../config';
import { logger } from '../lib/logger';

export const githubCloneApp = new Hono<AppEnv>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.INTERNAL_SERVICE_KEY) {
    headers['Authorization'] = `Bearer ${process.env.INTERNAL_SERVICE_KEY}`;
  }
  return headers;
}

function getSandboxExecUrl(baseUrl: string): string {
  return `${baseUrl}/kortix/core/exec`;
}

/** Parse owner/repo from a GitHub HTTPS URL. */
function parseGitHubUrl(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

/** Build authenticated clone URL (token never logged). */
function buildAuthenticatedUrl(repoUrl: string, token: string): string {
  if (!token) return repoUrl;
  return repoUrl.replace('https://', `https://${token}@`);
}

/** Run a command in the sandbox via /kortix/core/exec. Returns { code, stdout, stderr }. */
async function sandboxExec(baseUrl: string, cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const res = await fetch(getSandboxExecUrl(baseUrl), {
    method: 'POST',
    headers: getInternalHeaders(),
    body: JSON.stringify({ cmd }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`exec endpoint returned ${res.status}`);
  }
  return res.json() as Promise<{ code: number; stdout: string; stderr: string }>;
}

// ─── Route ───────────────────────────────────────────────────────────────────

githubCloneApp.post('/', async (c) => {
  const userId = c.get('userId') as string;

  let body: { repo_url?: string; github_access_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { repo_url, github_access_token } = body;

  if (!repo_url?.trim()) {
    return c.json({ error: 'repo_url is required' }, 400);
  }

  const parsed = parseGitHubUrl(repo_url.trim());
  if (!parsed) {
    return c.json({ error: 'repo_url must be a valid GitHub HTTPS URL (https://github.com/owner/repo)' }, 400);
  }

  const { owner, repo: repoName } = parsed;
  const repoSlug = `${owner}/${repoName}`;

  // Resolve active sandbox
  const accountId = await resolveAccountId(userId);
  const [sandboxRow] = await db
    .select({ externalId: sandboxes.externalId, baseUrl: sandboxes.baseUrl })
    .from(sandboxes)
    .where(eq(sandboxes.accountId, accountId))
    .orderBy(desc(sandboxes.updatedAt))
    .limit(1);

  if (!sandboxRow?.baseUrl) {
    return c.json({ error: 'no_sandbox', detail: 'No active sandbox found for this account' }, 503);
  }

  const baseUrl = sandboxRow.baseUrl;

  // Resolve token: request body → GITHUB_TOKEN config → empty (public only)
  const token =
    github_access_token?.trim() ||
    config.GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    '';

  // Build authenticated URL (never log the token)
  const cloneUrl = buildAuthenticatedUrl(`https://github.com/${repoSlug}.git`, token);
  const clonePath = `/workspace/${repoName}`;

  // Check if already cloned
  const checkResult = await sandboxExec(baseUrl, `test -d ${clonePath} && echo exists || echo missing`).catch(() => null);
  if (checkResult?.stdout.trim() === 'exists') {
    logger.info(`[github/clone] ${repoSlug} already cloned at ${clonePath}, skipping`);
  } else {
    // Execute git clone --depth 1 in sandbox
    // Mask token in log by using a placeholder
    logger.info(`[github/clone] Cloning ${repoSlug} into sandbox`);

    const cloneResult = await sandboxExec(
      baseUrl,
      `git clone --depth 1 ${cloneUrl} ${clonePath} 2>&1`,
    ).catch((err: unknown) => ({
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }));

    if (cloneResult.code !== 0) {
      const detail = (cloneResult.stdout + cloneResult.stderr)
        .replaceAll(token || '\x00', '***')  // mask token in error output
        .trim()
        .slice(0, 500);
      logger.warn(`[github/clone] Clone failed for ${repoSlug}: ${detail}`);
      return c.json({ error: 'clone_failed', detail }, 422);
    }
  }

  // Read README for context summary
  let readmeSummary = '';
  const readmeResult = await sandboxExec(
    baseUrl,
    `head -c 2000 ${clonePath}/README.md 2>/dev/null || ls ${clonePath} 2>/dev/null | head -30`,
  ).catch(() => null);
  if (readmeResult?.code === 0 && readmeResult.stdout.trim()) {
    readmeSummary = readmeResult.stdout.trim();
  }

  // Get default branch
  let defaultBranch = 'main';
  const branchResult = await sandboxExec(
    baseUrl,
    `git -C ${clonePath} symbolic-ref --short HEAD 2>/dev/null || echo main`,
  ).catch(() => null);
  if (branchResult?.code === 0 && branchResult.stdout.trim()) {
    defaultBranch = branchResult.stdout.trim();
  }

  logger.info(`[github/clone] ${repoSlug} ready at ${clonePath} (branch: ${defaultBranch})`);

  return c.json({
    cloned_path: clonePath,
    repo_name: repoSlug,
    readme_summary: readmeSummary,
    default_branch: defaultBranch,
  }, 200);
});
