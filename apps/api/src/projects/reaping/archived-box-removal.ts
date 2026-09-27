/**
 * Durable removal of the provider box behind a DELETED session.
 *
 * `deleteSession` archives the sandbox row and asks the provider to remove the
 * box. That one call can fail: a network error, or a provider that refuses a
 * remove while the box is mid-transition. The orphan-box reaper only ever
 * STOPS a box, so a failed remove used to leave the deleted session's disk on
 * the provider until the account was deleted.
 *
 * So the intent is recorded first. `deleteSession` stamps
 * `providerRemovalPendingAt` on the archived row in the same statement that
 * archives it, and only a CONFIRMED removal clears the stamp. This lane retries
 * every stamped row with a backoff until the provider confirms the box is gone.
 */

import { sessionSandboxes } from '@kortix/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { stripMetadataKeys } from '../session-lifecycle/sandbox-metadata-sql';

export const PROVIDER_REMOVAL_PENDING_KEY = 'providerRemovalPendingAt';

/**
 * Lifecycle fences a deleted session must not keep. A detached restart, wake or
 * recovery CASes on these keys; while they survive into the archived row, that
 * task's finalize still matches and can flip the row back to `active`.
 */
export const DELETED_SESSION_CLEARED_KEYS = [
  'runtimeRestartId',
  'runtimeRestartStartedAt',
  'runtimeRestartLeaseExpiresAt',
  'runtimeRestartPhase',
  'runtimeWakeId',
  'runtimeWakeStartedAt',
  'runtimeWakeLeaseExpiresAt',
  'runtimeWakeProviderStatus',
  'runtimeRecoveryLeaseId',
  'runtimeRecoveryLeaseAt',
  'runtimeRecoveryLeaseExpiresAtMs',
  'activeTurn',
  'activeTurns',
] as const;

const REMOVAL_BATCH = 50;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

/** Wait before the next attempt after `attempts` failures. */
export function removalBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
}

/** Pure decision for one stamped row: attempt a removal now, or wait. */
export function shouldAttemptRemoval(input: {
  providerAllowed: boolean;
  retryAfterMs: number | null;
  nowMs: number;
}): boolean {
  if (!input.providerAllowed) return false;
  return input.retryAfterMs === null || input.retryAfterMs <= input.nowMs;
}

function isAllowedProvider(provider: string): boolean {
  return (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(provider);
}

async function markRemoved(sandboxId: string, now: Date): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`(${stripMetadataKeys([
        PROVIDER_REMOVAL_PENDING_KEY,
        'providerRemovalAttempts',
        'providerRemovalRetryAfterAt',
        'providerRemovalError',
      ])}) || ${JSON.stringify({ providerRemovedAt: now.toISOString() })}::jsonb`,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.status, 'archived'),
      ),
    );
}

async function markRemovalFailed(
  sandboxId: string,
  attempts: number,
  error: unknown,
  now: Date,
): Promise<void> {
  const patch = {
    providerRemovalAttempts: attempts,
    providerRemovalRetryAfterAt: new Date(now.getTime() + removalBackoffMs(attempts)).toISOString(),
    providerRemovalError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
  };
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.status, 'archived'),
        sql`${sessionSandboxes.metadata} ? ${sql.raw(`'${PROVIDER_REMOVAL_PENDING_KEY}'`)}`,
      ),
    );
}

/**
 * One removal attempt for one archived row. Clears the pending stamp only when
 * the provider confirms the box is gone; otherwise records the failure and the
 * next retry time. Never throws.
 */
export async function attemptArchivedBoxRemoval(
  row: { sandboxId: string; externalId: string; provider: string; metadata: unknown },
  now = new Date(),
): Promise<'removed' | 'failed' | 'skipped'> {
  if (!isAllowedProvider(row.provider)) return 'skipped';
  const provider = getProvider(row.provider as SandboxProviderName);
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const attempts = Number(metadata.providerRemovalAttempts ?? 0) || 0;
  try {
    await provider.remove(row.externalId);
    await markRemoved(row.sandboxId, now);
    return 'removed';
  } catch (removeError) {
    // A remove that fails because the box is already gone is a success.
    const status = await provider.getStatus(row.externalId).catch(() => 'unknown' as const);
    if (status === 'removed') {
      await markRemoved(row.sandboxId, now);
      return 'removed';
    }
    await markRemovalFailed(row.sandboxId, attempts + 1, removeError, now).catch(() => undefined);
    console.warn(
      `[archived-box-removal] remove failed for ${row.externalId} (attempt ${attempts + 1}):`,
      removeError instanceof Error ? removeError.message : removeError,
    );
    return 'failed';
  }
}

/** The maintenance lane: retry every archived row whose removal is unconfirmed. */
export async function removeArchivedProviderBoxes(now = new Date()): Promise<{
  examined: number;
  removed: number;
  failed: number;
}> {
  const rows = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.status, 'archived'),
        isNotNull(sessionSandboxes.externalId),
        sql`${sessionSandboxes.metadata} ? ${sql.raw(`'${PROVIDER_REMOVAL_PENDING_KEY}'`)}`,
      ),
    )
    .orderBy(sql`${sessionSandboxes.metadata}->>'providerRemovalRetryAfterAt' asc nulls first`)
    .limit(REMOVAL_BATCH);

  let examined = 0;
  let removed = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.externalId) continue;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const retryAfter = Date.parse(String(metadata.providerRemovalRetryAfterAt ?? ''));
    const due = shouldAttemptRemoval({
      providerAllowed: isAllowedProvider(row.provider),
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter : null,
      nowMs: now.getTime(),
    });
    if (!due) continue;
    examined += 1;
    const outcome = await attemptArchivedBoxRemoval(
      { ...row, externalId: row.externalId },
      now,
    );
    if (outcome === 'removed') removed += 1;
    else if (outcome === 'failed') failed += 1;
  }
  return { examined, removed, failed };
}
