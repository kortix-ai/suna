import { eq, and, gt, lte, or, sql, asc } from 'drizzle-orm';
import { accountDeletionRequests } from '@kortix/db';
import { db } from '../../shared/db';
import { type StatusRule, transitionStatus } from '../../shared/status-transition';

export async function getActiveDeletionRequest(accountId: string) {
  const [row] = await db
    .select()
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.accountId, accountId),
        eq(accountDeletionRequests.status, 'pending'),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function createDeletionRequest(
  accountId: string,
  userId: string,
  scheduledFor: string,
  reason?: string,
) {
  const [row] = await db
    .insert(accountDeletionRequests)
    .values({
      accountId,
      userId,
      scheduledFor,
      reason: reason ?? null,
      status: 'pending',
    })
    .returning();

  return row;
}

/** True while the worker runs the account's deletion (`processing`): it can no longer be cancelled. */
export async function hasRunningDeletionRequest(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(and(eq(accountDeletionRequests.accountId, accountId), eq(accountDeletionRequests.status, 'processing')))
    .limit(1);
  return Boolean(row);
}

/**
 * The request's status moves. Cancel leaves only `pending`: once the worker
 * claimed a request (`processing`), its irreversible work runs, so a cancel
 * that lost that race must not read `cancelled` over it. Completion leaves
 * only an open request: it never overwrites a `cancelled` one.
 */
export const DELETION_TRANSITIONS = {
  cancel: { from: ['pending'], to: 'cancelled' },
  complete: { from: ['pending', 'processing'], to: 'completed' },
} as const satisfies Record<string, StatusRule>;

/** Cancel a pending request. False when the worker claimed it first (or it is no longer pending). */
export async function cancelDeletionRequest(requestId: string): Promise<boolean> {
  const moved = await transitionStatus(accountDeletionRequests, accountDeletionRequests.status, DELETION_TRANSITIONS.cancel, {
    where: eq(accountDeletionRequests.id, requestId),
    set: { cancelledAt: new Date().toISOString() },
  });
  return moved.applied;
}

/** Record the deletion as done. False when the request was cancelled or already completed. */
export async function markDeletionCompleted(requestId: string): Promise<boolean> {
  const moved = await transitionStatus(accountDeletionRequests, accountDeletionRequests.status, DELETION_TRANSITIONS.complete, {
    where: eq(accountDeletionRequests.id, requestId),
    set: {
      completedAt: new Date().toISOString(),
      // The row outlives the account as the deletion receipt; the user's
      // free-text reason does not.
      reason: null,
    },
  });
  return moved.applied;
}

/** A `processing` claim older than this belongs to a dead worker. */
const STALE_CLAIM_INTERVAL = sql`interval '1 hour'`;

/**
 * The worker never executes a request more than this far past its date. It
 * ticks every 15 minutes, so a normal request runs within one tick. An older
 * one is a backlog: prod held 410 never-executed requests from 2026-04-25 on
 * (5 accounts active after their request, 17 on a paid tier) when the worker
 * shipped. Deleting those is an irreversible product decision, so they stay
 * `pending` for a person (`countOverdueBacklog`). An auth-user delete
 * inserts a request due now, which runs; it sets an existing pending request
 * to `least(scheduled_for, now())`, so a backlog row keeps its old date and
 * still waits for a person.
 */
const MAX_OVERDUE = sql`interval '2 days'`;

/** Due requests: `pending`, plus `processing` claims a dead worker left behind. */
function dueRequest() {
  return and(
    lte(accountDeletionRequests.scheduledFor, sql`now()`),
    gt(accountDeletionRequests.scheduledFor, sql`now() - ${MAX_OVERDUE}`),
    or(
      eq(accountDeletionRequests.status, 'pending'),
      and(
        eq(accountDeletionRequests.status, 'processing'),
        lte(accountDeletionRequests.processingStartedAt, sql`now() - ${STALE_CLAIM_INTERVAL}`),
      ),
    ),
  );
}

/** Pending requests the worker leaves for a person (see `MAX_OVERDUE`). */
export async function countOverdueBacklog(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.status, 'pending'),
        lte(accountDeletionRequests.scheduledFor, sql`now() - ${MAX_OVERDUE}`),
      ),
    );
  return row?.count ?? 0;
}

/** The `limit` oldest due requests. */
export async function getScheduledDeletions(limit: number) {
  return db
    .select()
    .from(accountDeletionRequests)
    .where(dueRequest())
    .orderBy(asc(accountDeletionRequests.scheduledFor))
    .limit(limit);
}

/**
 * Atomically take one due request. Returns null when a cancel, another replica
 * or a completed run got there first. The irreversible work starts only after
 * this returns a row.
 */
export async function claimDeletionRequest(requestId: string) {
  const [row] = await db
    .update(accountDeletionRequests)
    .set({ status: 'processing', processingStartedAt: sql`now()` })
    .where(and(eq(accountDeletionRequests.id, requestId), dueRequest()))
    .returning();
  return row ?? null;
}

/**
 * Take a request for the immediate path (`deleteAccountImmediately`), whatever
 * its date: `pending`, or a `processing` claim a dead worker left. Null when a
 * cancel, the worker or another immediate run got there first.
 */
export async function claimDeletionRequestNow(requestId: string) {
  const [row] = await db
    .update(accountDeletionRequests)
    .set({ status: 'processing', processingStartedAt: sql`now()` })
    .where(
      and(
        eq(accountDeletionRequests.id, requestId),
        or(
          eq(accountDeletionRequests.status, 'pending'),
          and(
            eq(accountDeletionRequests.status, 'processing'),
            lte(accountDeletionRequests.processingStartedAt, sql`now() - ${STALE_CLAIM_INTERVAL}`),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Return a failed claim to `pending` so the next tick retries it. */
export async function releaseDeletionRequest(requestId: string) {
  await db
    .update(accountDeletionRequests)
    .set({ status: 'pending', processingStartedAt: null })
    .where(
      and(eq(accountDeletionRequests.id, requestId), eq(accountDeletionRequests.status, 'processing')),
    );
}

/**
 * Take one open request for the retention backstop (`retention-erasure.ts`),
 * however far past its date: the backstop selects requests long past
 * `MAX_OVERDUE`. The date must have passed and the request must not be
 * cancelled, whatever the caller selected. Same claim rules otherwise:
 * `pending`, or a `processing` claim a dead worker left. Null when a cancel or
 * another worker got there first.
 */
export async function claimOpenDeletionRequest(requestId: string) {
  const [row] = await db
    .update(accountDeletionRequests)
    .set({ status: 'processing', processingStartedAt: sql`now()` })
    .where(
      and(
        eq(accountDeletionRequests.id, requestId),
        lte(accountDeletionRequests.scheduledFor, sql`now()`),
        sql`not coalesce(${accountDeletionRequests.isCancelled}, false)`,
        or(
          eq(accountDeletionRequests.status, 'pending'),
          and(
            eq(accountDeletionRequests.status, 'processing'),
            lte(accountDeletionRequests.processingStartedAt, sql`now() - ${STALE_CLAIM_INTERVAL}`),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}
