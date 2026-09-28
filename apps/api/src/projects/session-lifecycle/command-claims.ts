import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { currentInstanceId } from '../instance-scope';
import { db } from '../../shared/db';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { inboxLaneSql, inboxSentAtSql, inboxWireIdSql } from './inbox-order';
import { LIFECYCLE_CLAIM_LOCK_MS } from './command-lease';
type SessionLifecycleCommandRow = typeof sessionLifecycleCommands.$inferSelect;

/**
 * How long past its expired lock a `running` row waits before another worker
 * takes it.
 *
 * A row goes `running` at claim time and stays there for the whole delivery,
 * which can be a full cold-boot wait. If the pod handling it dies in that
 * window — a rollout, an OOM — nothing ever puts the row back: the claim only
 * ever looked at `queued`. Its session's inbox then wedges for ever, because
 * `older_prompt_pending` counts `running`.
 *
 * The grace sits ON TOP of the 5-minute lock, so a worker that is merely slow
 * has ten minutes before anyone else touches its row, and a duplicate delivery
 * would still be absorbed by the proxy's `Idempotency-Key` claim.
 */
export const LIFECYCLE_RUNNING_RECLAIM_GRACE_MS = 5 * 60_000;

export async function claimDueLifecycleCommands(input: {
  workerId: string;
  limit: number;
  now?: Date;
  /** Claim only the callback with this durable idempotency key. */
  idempotencyKey?: string;
  /** Claim only commands that came due before this instant (default: now).
   *  Lets the starvation reconciler target rows the scheduler drain should
   *  have taken long ago, without racing it for freshly-due ones. */
  availableBefore?: Date;
}): Promise<SessionLifecycleCommandRow[]> {
  const now = input.now ?? new Date();
  const staleRunningBefore = new Date(now.getTime() - LIFECYCLE_RUNNING_RECLAIM_GRACE_MS);
  const instanceId = currentInstanceId();
  const rows = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(
      and(
        // Do not claim a peer worktree's rows and postpone them before its own
        // worker can see them. Deployed replicas have no instance scope.
        instanceId ? sql`NOT EXISTS (
          SELECT 1 FROM ${sessionSandboxes} AS box
          WHERE box.session_id = ${qualifiedColumn(sessionLifecycleCommands.sessionId)}
            AND COALESCE(box.metadata->>'instanceId', '') NOT IN ('', ${instanceId})
        )` : undefined,
        or(
          and(
            eq(sessionLifecycleCommands.status, 'queued'),
            or(
              isNull(sessionLifecycleCommands.lockedUntil),
              lte(sessionLifecycleCommands.lockedUntil, now),
            ),
          ),
          // ABANDONED CLAIM. A `running` row whose lock expired a full grace
          // ago has no live worker: the pod that claimed it is gone. Left
          // alone it wedges its session's inbox for ever.
          and(
            eq(sessionLifecycleCommands.status, 'running'),
            lte(sessionLifecycleCommands.lockedUntil, staleRunningBefore),
          ),
        ),
        input.idempotencyKey
          ? eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey)
          : undefined,
        lte(sessionLifecycleCommands.availableAt, input.availableBefore ?? now),
      ),
    )
    .orderBy(
      asc(sessionLifecycleCommands.availableAt),
      asc(inboxLaneSql),
      asc(inboxSentAtSql),
      asc(inboxWireIdSql),
      asc(sessionLifecycleCommands.commandId),
    )
    .limit(input.limit);

  const claimed: SessionLifecycleCommandRow[] = [];
  for (const row of rows) {
    const [locked] = await db
      .update(sessionLifecycleCommands)
      .set({
        status: 'running',
        attempts: row.attempts + 1,
        result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) - 'delivery_started_at'`,
        lockedBy: input.workerId,
        lockedUntil: new Date(now.getTime() + LIFECYCLE_CLAIM_LOCK_MS),
        updatedAt: now,
      })
      // CAS on the exact state this row was read in — its status AND its lock
      // OWNER. For a `queued` row the status flip alone is exclusive, as it
      // always was. For a reclaimed `running` row there is no flip to rely on,
      // so the owner is what makes it exclusive: the first worker to write its
      // own id takes the row, and the second no longer matches. (The lock
      // TIMESTAMP cannot serve here — Postgres keeps microseconds that a JS
      // `Date` has already rounded away, so an equality on it never matches.)
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, row.commandId),
          eq(sessionLifecycleCommands.status, row.status),
          row.lockedBy
            ? eq(sessionLifecycleCommands.lockedBy, row.lockedBy)
            : isNull(sessionLifecycleCommands.lockedBy),
        ),
      )
      .returning();
    if (locked) claimed.push(locked);
  }
  return claimed;
}
