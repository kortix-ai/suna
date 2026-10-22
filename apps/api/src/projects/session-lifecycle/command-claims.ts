import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { currentInstanceId } from '../instance-scope';
import { db } from '../../shared/db';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { compareInboxSendOrder, inboxOrderBy } from './inbox-order';
import { LIFECYCLE_CLAIM_LOCK_MS } from './command-lease';
import { notHeldSql } from './delivery-state';
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
  // ONE statement. The inner SELECT takes the row locks and skips rows another
  // claim holds; a row whose status another claim changed meanwhile is
  // rechecked against this predicate and drops out. It ran as a SELECT plus
  // one compare-and-set UPDATE per row: 1 + n round trips per drain, on the
  // path of every prompt. `ARRAY(...)` makes the subquery run exactly once, so
  // `LIMIT` holds.
  const due = dueLifecycleCommandIds({ ...input, now });
  const claimed = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'running',
      attempts: sql`${sessionLifecycleCommands.attempts} + 1`,
      result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) - 'delivery_started_at'`,
      lockedBy: input.workerId,
      lockedUntil: new Date(now.getTime() + LIFECYCLE_CLAIM_LOCK_MS),
      updatedAt: now,
    })
    .where(sql`${sessionLifecycleCommands.commandId} = ANY(ARRAY(${due}))`)
    .returning();
  // RETURNING has no order. Restore the queue's.
  return claimed.sort(
    (left, right) =>
      left.availableAt.getTime() - right.availableAt.getTime() || compareInboxSendOrder(left, right),
  );
}

/** The claim's row-locking SELECT. Exported for the DB suite's plan check. */
export function dueLifecycleCommandIds(input: {
  limit: number;
  now: Date;
  idempotencyKey?: string;
  availableBefore?: Date;
}) {
  const now = input.now;
  const staleRunningBefore = new Date(now.getTime() - LIFECYCLE_RUNNING_RECLAIM_GRACE_MS);
  const instanceId = currentInstanceId();
  return db
    .select({ commandId: sessionLifecycleCommands.commandId })
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
            // A literal, not a bound parameter: under a generic prepared plan
            // `status = $n` cannot prove the predicate of the partial index
            // `idx_session_lifecycle_commands_claimable`, and the claim then
            // detoasts the payload of every held prompt on each tick.
            sql`${sessionLifecycleCommands.status} = 'queued'`,
            or(
              isNull(sessionLifecycleCommands.lockedUntil),
              lte(sessionLifecycleCommands.lockedUntil, now),
            ),
            // A HELD inbox prompt waits for the user's action, whatever its due
            // time: its delivery re-reads the hold before the POST and gives
            // the row straight back (`assertInboxDeliveryActive`). Several
            // writers put a held row back due — a paused delivery, a park, an
            // admission requeue — and each claim of it looped once per drain
            // tick. An automation row has no such check; its hold still ends
            // at `available_at`.
            // Held rows stay out of `idx_..._claimable`. One can still reach
            // this recheck through the `running` arm's `locked_until` index if
            // it is held with a stale `locked_until`; prod had 0 such rows of
            // 19 held on 2026-10-20.
            sql`(${notHeldSql}
              OR ${sessionLifecycleCommands.payload}->>'clientMessageId' IS NULL)`,
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
    .orderBy(asc(sessionLifecycleCommands.availableAt), ...inboxOrderBy())
    .limit(input.limit)
    .for('update', { skipLocked: true });
}
