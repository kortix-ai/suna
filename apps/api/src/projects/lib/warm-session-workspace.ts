import { sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { db } from '../../shared/db';
import { KORTIX_SERVICE_CALL_HEADER } from '../../shared/kortix-user-context';
import { resolveCommitSha, type GitBackedProject } from '../git';

export interface WarmSessionWorkspaceRefresh {
  status: 'skipped' | 'unchanged' | 'updated' | 'failed';
  before_sha?: string | null;
  after_sha?: string | null;
  error?: string;
}

interface ActiveWarmSessionSandbox {
  externalId: string;
  serviceKey: string;
}

interface WarmSessionWorkspaceDependencies {
  loadActiveSandbox: (sessionId: string) => Promise<ActiveWarmSessionSandbox | null>;
  resolveBaseSha: (project: GitBackedProject) => Promise<string>;
  resolveIngress: (
    externalId: string,
  ) => Promise<{ url: string; headers: Record<string, string> }>;
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

async function loadActiveSandbox(
  sessionId: string,
): Promise<ActiveWarmSessionSandbox | null> {
  const [row] = await db
    .select({
      externalId: sessionSandboxes.externalId,
      config: sessionSandboxes.config,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        eq(sessionSandboxes.status, 'active'),
      ),
    )
    .orderBy(desc(sessionSandboxes.updatedAt))
    .limit(1);
  if (!row?.externalId) return null;
  const config = (row.config ?? {}) as Record<string, unknown>;
  const serviceKey =
    typeof config.serviceKey === 'string' && config.serviceKey
      ? config.serviceKey
      : null;
  if (!serviceKey) return null;
  return { externalId: row.externalId, serviceKey };
}

const defaultDependencies: WarmSessionWorkspaceDependencies = {
  loadActiveSandbox,
  resolveBaseSha: (project) =>
    resolveCommitSha(project, project.defaultBranch),
  resolveIngress: async (externalId) =>
    resolveSandboxIngress(externalId, { port: 8000, transport: 'http' }),
  fetch: globalThis.fetch,
};

export async function refreshWarmSessionWorkspace(
  project: GitBackedProject,
  sessionId: string,
  dependencies: WarmSessionWorkspaceDependencies = defaultDependencies,
): Promise<WarmSessionWorkspaceRefresh> {
  try {
    const sandbox = await dependencies.loadActiveSandbox(sessionId);
    if (!sandbox) return { status: 'skipped' };

    const [baseSha, ingress] = await Promise.all([
      dependencies.resolveBaseSha(project),
      dependencies.resolveIngress(sandbox.externalId),
    ]);
    const headers = new Headers(ingress.headers);
    headers.set('Authorization', `Bearer ${sandbox.serviceKey}`);
    // `base=1` below is the destructive branch reset, so the daemon demands
    // proof this is a DIRECT call and not one relayed through the user-facing
    // proxy — which authenticates user traffic with this same service key. The
    // proxy strips this header, so only a direct caller can present it.
    headers.set(KORTIX_SERVICE_CALL_HEADER, '1');
    const query = new URLSearchParams({
      base: '1',
      base_sha: baseSha,
      restart: '0',
    });
    const response = await dependencies.fetch(
      `${ingress.url.replace(/\/+$/, '')}/kortix/refresh?${query}`,
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
      return {
        status: 'failed',
        error: `workspace refresh failed: ${response.status}${detail ? ` ${detail}` : ''}`,
      };
    }

    const body = (await response.json().catch(() => null)) as {
      repo?: {
        before?: { commit?: unknown };
        after?: { commit?: unknown };
      };
    } | null;
    const before =
      typeof body?.repo?.before?.commit === 'string'
        ? body.repo.before.commit
        : null;
    const after =
      typeof body?.repo?.after?.commit === 'string'
        ? body.repo.after.commit
        : null;
    return {
      status: before && after && before !== after ? 'updated' : 'unchanged',
      before_sha: before,
      after_sha: after,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
