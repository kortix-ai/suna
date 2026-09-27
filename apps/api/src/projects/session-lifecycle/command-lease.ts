import { sessionLifecycleCommands } from '@kortix/db';
import { type SQL, and, eq, isNull } from 'drizzle-orm';

import { logger } from '../../lib/logger';
import { db } from '../../shared/db';

/**
 * The lease a worker holds on a claimed (`running`) lifecycle command row.
 *
 * A claim writes `status = 'running'`, `locked_by = <this claim's worker id>`
 * and `locked_until = now + LIFECYCLE_CLAIM_LOCK_MS`. The lease is the pair
 * `(command_id, locked_by)` the claim returned.
 *
 *   - Every write that ENDS the claim — succeed, forward, fail, requeue, park,
 *     release — names the lease and applies only while the row is still
 *     `running` under the same `locked_by`. A worker whose row was reclaimed
 *     after its lock expired writes nothing: its late verdict cannot reopen or
 *     close a row another worker now owns.
 *   - A worker that holds a row longer than one lock period (a cold-boot
 *     delivery waits up to 5 minutes for readiness) renews `locked_until` with
 *     {@link withCommandLeaseHeartbeat}. A live worker's row is therefore never
 *     reclaimed, and an expired lock means the worker is gone.
 *   - The drain reclaims a `running` row whose lock expired a full grace ago
 *     (`claimDueLifecycleCommands`), under a new `locked_by`.
 *
 * This is the lease/epoch fencing of `provider-transition-store.ts`, with the
 * per-claim worker id as the fencing token.
 */
export type CommandLease = { commandId: string; lockedBy: string | null };

/** The lock a claim holds before an abandoned `running` row can be reclaimed. */
export const LIFECYCLE_CLAIM_LOCK_MS = 5 * 60_000;

/** How often a held lease renews its lock: three renewals per lock period. */
export const LIFECYCLE_LEASE_HEARTBEAT_MS = LIFECYCLE_CLAIM_LOCK_MS / 3;

/** The row is still `running` under this lease. ANDed into every lease write. */
export function ownedByLease(lease: CommandLease): SQL {
  return and(
    eq(sessionLifecycleCommands.commandId, lease.commandId),
    eq(sessionLifecycleCommands.status, 'running'),
    lease.lockedBy === null
      ? isNull(sessionLifecycleCommands.lockedBy)
      : eq(sessionLifecycleCommands.lockedBy, lease.lockedBy),
  ) as SQL;
}

/** A lease write matched no row: another worker owns the command now. */
export function logLeaseLost(lease: CommandLease, write: string): void {
  logger.warn('[session-lifecycle] command lease lost — write skipped', {
    command_id: lease.commandId,
    locked_by: lease.lockedBy,
    write,
  });
}

/** Push `locked_until` one lock period out. False when the lease is gone. */
export async function heartbeatCommandLease(lease: CommandLease, now = new Date()): Promise<boolean> {
  const [renewed] = await db
    .update(sessionLifecycleCommands)
    .set({ lockedUntil: new Date(now.getTime() + LIFECYCLE_CLAIM_LOCK_MS) })
    .where(ownedByLease(lease))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return Boolean(renewed);
}

/**
 * Run `work` while renewing the lease every `intervalMs`. The renewal stops
 * when `work` settles, or when a renewal finds the lease gone. A renewal that
 * fails on a database error is retried on the next tick: the lock still has
 * two thirds of its period left.
 */
export async function withCommandLeaseHeartbeat<T>(
  lease: CommandLease,
  work: () => Promise<T>,
  intervalMs = LIFECYCLE_LEASE_HEARTBEAT_MS,
): Promise<T> {
  let stopped = false;
  const timer = setInterval(() => {
    heartbeatCommandLease(lease)
      .then((owned) => {
        if (owned || stopped) return;
        stopped = true;
        clearInterval(timer);
        logLeaseLost(lease, 'heartbeat');
      })
      .catch((err) =>
        logger.warn('[session-lifecycle] command lease heartbeat failed', {
          command_id: lease.commandId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }, intervalMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}
