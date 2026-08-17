/**
 * Syncing OUR rows to the provider's real state, keyed by external id.
 *
 * These are the deterministic billing-close paths shared by the provider
 * webhook ingress (the fast path, closing billing the instant a provider says a
 * box stopped) and the reaper sweep (the backstop that runs even when an event
 * is dropped). Idempotent by construction: a row already stopped/archived is a
 * no-op, so the two paths can race freely.
 */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { pauseComputeSession } from '../../billing/services/compute-metering';
import { revokeSessionConnectorTokens } from '../../repositories/account-tokens';
import { invalidateProviderCache } from '../../sandbox-proxy';
import { db } from '../../shared/db';
import { preserveEstablishedRuntime } from '../runtime-identity';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';
import type { StopReason } from '../stop-reason';

/** Merge keys into a jsonb metadata column without clobbering siblings. */
export function mergeMetadata(patch: Record<string, unknown>) {
  return sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

export interface StoppedStateWrite {
  sandboxId: string;
  sessionId: string;
  externalId: string | null;
  /** WHY this box parked. Required — the classification query groups on it. */
  stopReason: StopReason;
  /** Extra keys to record about the stop. Merged, never assigned. */
  metadata?: Record<string, unknown>;
  now?: Date;
}

/**
 * THE stop write. Every path that parks a sandbox — the reaper's idle stop, the
 * reaper's provider-confirmed reconcile, the webhook ingress, the user's manual
 * stop — goes through this one function.
 *
 * It exists because the procedure used to be copy-pasted three times and had
 * already drifted: two copies merged the metadata patch into the jsonb column,
 * the third assigned a whole object built from a row read moments earlier, which
 * silently dropped anything a concurrent writer had put there in between (the
 * `runtimeWakeId` fence and the `lastAliveAt` liveness stamp the billing clamp
 * depends on both live in that column). And the money-critical step order —
 * settle the meter against the still-active row BEFORE flipping the status —
 * was recorded as a comment repeated in each copy. A comment is not a mechanism;
 * a single function is.
 *
 * So, in order, and nowhere else:
 *   1. close the compute window while the row still says `active`, so the final
 *      window is settled against the state it was actually billed under;
 *   2. flip `session_sandboxes` and `project_sessions` in ONE transaction, so
 *      there is no window where the box is parked but the session still claims
 *      to be running (and no way for a caller to do one and forget the other);
 *   3. drop the proxy's provider cache.
 * Metadata is ALWAYS a jsonb merge — this module has no whole-object writer.
 */
export async function applyStoppedState(write: StoppedStateWrite): Promise<void> {
  const now = write.now ?? new Date();
  await pauseComputeSession(write.sandboxId).catch((err) =>
    console.warn(
      `[reaper] pauseComputeSession failed for ${write.sandboxId}:`,
      err instanceof Error ? err.message : err,
    ),
  );
  const patch = {
    ...(write.metadata ?? {}),
    stopReason: write.stopReason,
    stoppedAt: now.toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(sessionSandboxes)
      .set({
        status: 'stopped',
        updatedAt: now,
        // A committed stop cancels any in-flight wake. If provider.start()
        // resolves after this transaction, its fenced completion write loses
        // and the resume path stops the provider again. This makes an explicit
        // user stop win both orderings of the start/stop race.
        //
        // `patch` always carries stopReason + stoppedAt, so this is never an
        // empty merge. The same statement drops wake fences and every turn
        // authority record. A provider webhook can win the idle-stop race
        // before the reaper clears an unknown turn. A stopped sandbox cannot
        // retain authority that a later resume could misread. Still a MERGE,
        // never a whole-object assign — a concurrent writer's lastAliveAt lives
        // in this column too.
        metadata: sql`(coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
          - 'runtimeWakeStartedAt'
          - 'runtimeWakeId'
          - 'runtimeWakeLeaseExpiresAt'
          - 'runtimeWakeProviderStatus'
          - 'runtimeWakeCleanupId'
          - 'runtimeWakeCleanupLeaseExpiresAt'
          - 'activeTurn'
          - 'activeTurns'
          - 'lifecycleStopClaim') || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(sessionSandboxes.sandboxId, write.sandboxId));
    await tx
      .update(projectSessions)
      .set({ status: 'stopped', updatedAt: now })
      .where(eq(projectSessions.sessionId, write.sessionId));
  });
  if (write.externalId) invalidateProviderCache(write.externalId);
}

/**
 * Close billing + reconcile a sandbox the PROVIDER reports stopped/archived,
 * keyed by external id. Returns true if it transitioned a live row.
 */
export async function reconcileSandboxStoppedByExternalId(
  externalId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      status: sessionSandboxes.status,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row) return false;
  if (row.status === 'stopped' || row.status === 'archived') return false;
  if (runtimeWakeInProgress(row.metadata, now)) return false;
  // A stopped box stays stopped: passive /v1/p traffic (markSandboxUsed heal /
  // wakeSandbox) must not resurrect it. That used to need an `idleQuiesced`
  // flag written here; the heal now refuses any row whose deadline has passed —
  // the same rows, one fewer piece of state.
  await applyStoppedState({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId,
    stopReason: 'provider_reconcile',
    now,
  });
  return true;
}

/**
 * The provider reports the box destroyed/deleted/lost — finalize billing and
 * preserve the original mapping. Keyed by external id; idempotent. Shared by
 * webhook ingress + reaper.
 */
export async function reconcileSandboxRemovedByExternalId(
  externalId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
      status: sessionSandboxes.status,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row) return false;
  if (!row.externalId) return false;
  await preserveEstablishedRuntime(row, 'provider_webhook_removed', 'provider_removed', now);
  // The box is GONE at the provider — unlike an idle stop, nothing can wake it,
  // so its connector token is now a bearer credential with no owner. Nothing
  // else ever expires these (no expiresAt, exempt from PAT idle-revoke).
  await revokeSessionConnectorTokens(row.sessionId, row.accountId).catch((err) =>
    console.error(
      `[reaper] FAILED to revoke connector tokens for removed sandbox ${externalId} (session ${row.sessionId}):`,
      err,
    ),
  );
  invalidateProviderCache(externalId);
  return true;
}
