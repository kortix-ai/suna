/**
 * Retired sandbox-level warm pool.
 *
 * The old pool pre-created sandboxes whose id later became the user-visible
 * session id. That made warm allocation a second session-creation path. Session
 * lifecycle is now single-owner: `createProjectSession` creates the durable row,
 * then the runtime allocator provisions compute for that exact session id.
 *
 * Keep this small compatibility surface so older UI/config paths keep loading
 * and maintenance can reap any already-parked pool rows. Do not add runtime
 * creation here; warm strategies must live behind the session runtime allocator.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { sessionSandboxes } from '@kortix/db';
import { config } from '../../config';
import { db } from '../../shared/db';
import { getProvider } from '../providers';

const POOL_BOOT_TIMEOUT_MS = 8 * 60 * 1000;
const POOL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_WARM_SIZE = 25;

export interface WarmPoolConfig {
  enabled: boolean;
  size: number;
}

export const warmPoolEnabled = (): boolean => false;

/** Effective per-project warm config kept for response compatibility. */
export function resolveWarmConfig(metadata: unknown): WarmPoolConfig {
  const defaultSize = Math.max(0, config.KORTIX_WARM_POOL_SIZE);
  const wp = (metadata as Record<string, unknown> | null | undefined)?.warm_pool;
  if (wp && typeof wp === 'object' && !Array.isArray(wp)) {
    const raw = wp as Record<string, unknown>;
    const size =
      typeof raw.size === 'number' && Number.isInteger(raw.size) && raw.size >= 0
        ? Math.min(raw.size, MAX_WARM_SIZE)
        : defaultSize;
    return { enabled: false, size };
  }
  return { enabled: false, size: defaultSize };
}

export function warmBoxReapReason(
  row: { poolState: string | null; status: string; createdAt: Date; updatedAt: Date },
  now: number,
  opts: { bootTimeoutMs?: number; maxAgeMs?: number } = {},
): string | null {
  const bootTimeoutMs = opts.bootTimeoutMs ?? POOL_BOOT_TIMEOUT_MS;
  const maxAgeMs = opts.maxAgeMs ?? POOL_MAX_AGE_MS;
  if (row.poolState === 'reap') return 'marked';
  if (row.status === 'error') return 'errored';
  if (row.poolState === 'booting' && now - row.createdAt.getTime() > bootTimeoutMs) return 'boot-timeout';
  if (row.poolState === 'parked' && now - row.createdAt.getTime() > maxAgeMs) return 'aged-out';
  return null;
}

export async function getWarmPoolCounts(projectId: string): Promise<{ ready: number; warming: number }> {
  const rows = await db
    .select({ poolState: sessionSandboxes.poolState, n: sql<number>`count(*)::int` })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.projectId, projectId), inArray(sessionSandboxes.poolState, ['parked', 'booting'])))
    .groupBy(sessionSandboxes.poolState);
  let ready = 0;
  let warming = 0;
  for (const r of rows) {
    if (r.poolState === 'parked') ready = Number(r.n);
    else if (r.poolState === 'booting') warming = Number(r.n);
  }
  return { ready, warming };
}

export async function refillProjectPool(_projectId: string, _forUserId?: string | null): Promise<void> {
  return;
}

export function notePoolPresence(_projectId: string, _userId?: string | null): void {
  return;
}

export async function reconcileWarmPool(now = new Date()): Promise<{ reaped: number; projects: number }> {
  let reaped = 0;
  const poolRows = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
      poolState: sessionSandboxes.poolState,
      status: sessionSandboxes.status,
      createdAt: sessionSandboxes.createdAt,
      updatedAt: sessionSandboxes.updatedAt,
    })
    .from(sessionSandboxes)
    .where(inArray(sessionSandboxes.poolState, ['booting', 'parked', 'reap']));

  for (const row of poolRows) {
    await reapWarmSandbox(row);
    reaped++;
  }
  return { reaped, projects: 0 };
}

async function reapWarmSandbox(row: { sandboxId: string; externalId: string | null; provider: string }): Promise<void> {
  try {
    if (row.externalId) await getProvider(row.provider as any).remove(row.externalId);
  } catch (err) {
    console.warn(`[warm-pool] provider remove failed for ${row.sandboxId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
  }
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, row.sandboxId)).catch(() => {});
}
