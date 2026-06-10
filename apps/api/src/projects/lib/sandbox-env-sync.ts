import { and, eq } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolvePreviewLink } from '../../sandbox-proxy/backend';
import { resolveShareSubject } from '../../executor/share';
import {
  listProjectSecretsForUser,
  projectSecretsRevision,
} from '../secrets';
import { sanitizeSandboxEnv } from './sandbox-env-names';

const SANDBOX_SERVICE_PORT = 8000;
const FANOUT_CONCURRENCY = 6;
const ENV_PUSH_TIMEOUT_MS = 15_000;

export interface SandboxEnvSnapshot {
  env: Record<string, string>;
  names: string[];
  revision: string;
}

async function resolveOwnerRawEnv(
  projectId: string,
  sessionId: string | null,
): Promise<Record<string, string> | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select({ createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row?.createdBy) return null;
  const subject = await resolveShareSubject(row.createdBy);
  return listProjectSecretsForUser(projectId, subject);
}

export async function resolveSandboxEnvSnapshot(
  projectId: string,
  sessionId: string | null,
): Promise<SandboxEnvSnapshot | null> {
  const raw = await resolveOwnerRawEnv(projectId, sessionId);
  if (!raw) return null;
  const { env, names } = sanitizeSandboxEnv(raw);
  return { env, names, revision: projectSecretsRevision(env) };
}

async function postEnvToDaemon(args: {
  previewUrl: string;
  previewToken: string | null;
  serviceKey: string;
  snapshot: SandboxEnvSnapshot;
}): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.serviceKey}`,
    'X-Daytona-Skip-Preview-Warning': 'true',
    'X-Daytona-Disable-CORS': 'true',
  };
  if (args.previewToken) headers['X-Daytona-Preview-Token'] = args.previewToken;

  const res = await fetch(`${args.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args.snapshot),
    signal: AbortSignal.timeout(ENV_PUSH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`env sync failed: ${res.status}${body ? ` ${body.slice(0, 500)}` : ''}`);
  }
}

export async function syncSandboxEnvForPrompt(args: {
  projectId: string;
  sessionId: string;
  serviceKey: string | null;
  previewUrl: string;
  previewToken: string | null;
}): Promise<void> {
  if (!args.serviceKey) return;
  const snapshot = await resolveSandboxEnvSnapshot(args.projectId, args.sessionId);
  if (!snapshot) return;
  await postEnvToDaemon({
    previewUrl: args.previewUrl,
    previewToken: args.previewToken,
    serviceKey: args.serviceKey,
    snapshot,
  });
}

export async function propagateProjectSecretsToActiveSandboxes(projectId: string): Promise<void> {
  try {
    const rows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));

    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    if (targets.length === 0) return;

    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const config = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
      if (!serviceKey) return;
      try {
        const snapshot = await resolveSandboxEnvSnapshot(projectId, row.sessionId);
        if (!snapshot) return;
        const { url, token } = await resolvePreviewLink(row.externalId, SANDBOX_SERVICE_PORT);
        await postEnvToDaemon({ previewUrl: url, previewToken: token, serviceKey, snapshot });
      } catch (err) {
        console.warn(
          `[env-sync] hot push failed for sandbox ${row.externalId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
  } catch (err) {
    console.warn(
      `[env-sync] hot fan-out failed for project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
