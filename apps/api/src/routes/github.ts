/**
 * GitHub integration routes.
 *
 * Mounted at /v1/github/*
 *
 * Routes:
 *   POST /v1/github/pull-request — create a GitHub PR and return metadata + CI status
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { config } from '../config';
import { logger } from '../lib/logger';

export const githubApp = new Hono<AppEnv>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getGitHubToken(): string | null {
  // credential_get("GITHUB_TOKEN") — resolves from env/config in API context.
  return config.GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
}

type CiStatus = 'pending' | 'pass' | 'fail' | null;

async function fetchCiStatus(
  repo: string,
  sha: string,
  token: string,
): Promise<CiStatus> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}/check-runs`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!res.ok) {
      logger.warn(`[GitHub] check-runs fetch failed (${res.status}) for ${repo}@${sha}`);
      return null;
    }

    const data = await res.json() as {
      check_runs?: Array<{ conclusion: string | null; status: string }>;
    };

    const runs = data.check_runs ?? [];
    if (runs.length === 0) return 'pending';

    const hasFail = runs.some(
      (r) => r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out',
    );
    if (hasFail) return 'fail';

    const hasInProgress = runs.some(
      (r) => r.status === 'in_progress' || r.status === 'queued' || r.conclusion == null,
    );
    if (hasInProgress) return 'pending';

    return 'pass';
  } catch (err) {
    logger.warn('[GitHub] check-runs error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── POST /v1/github/pull-request ───────────────────────────────────────────

githubApp.post('/pull-request', async (c) => {
  const token = getGitHubToken();
  if (!token) {
    return c.json({ error: 'GITHUB_TOKEN not configured' }, 503);
  }

  let body: {
    repo?: string;
    branch?: string;
    base?: string;
    title?: string;
    body?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { repo, branch, base, title, body: prBody } = body;

  if (!repo || !branch || !base) {
    return c.json({ error: 'Missing required fields: repo, branch, base' }, 400);
  }

  // Create the PR
  const createRes = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title: title ?? branch,
      body: prBody ?? '',
      head: branch,
      base,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    let parsed: { message?: string } = {};
    try { parsed = JSON.parse(errText); } catch { /* raw text */ }

    if (createRes.status === 422) {
      return c.json({ error: parsed.message ?? errText }, 422);
    }

    logger.error('[GitHub] PR creation failed', {
      status: createRes.status,
      repo,
      branch,
      error: parsed.message ?? errText,
    });
    return c.json({ error: parsed.message ?? 'GitHub API error' }, createRes.status as 400 | 401 | 403 | 404 | 422 | 500);
  }

  const pr = await createRes.json() as {
    html_url: string;
    number: number;
    head: { sha: string };
  };

  const ci_status = await fetchCiStatus(repo, pr.head.sha, token);

  logger.info(`[GitHub] PR created: ${pr.html_url} (${repo}#${pr.number})`, {
    repo,
    branch,
    pr_number: pr.number,
    ci_status,
  });

  return c.json(
    {
      pr_url: pr.html_url,
      pr_number: pr.number,
      ci_status,
    },
    201,
  );
});
