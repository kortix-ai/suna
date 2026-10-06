import { eq, and, gt, lte, or, sql } from 'drizzle-orm';
import { accountDeletionRequests } from '@kortix/db';
import { db } from '../../shared/db';

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

export async function cancelDeletionRequest(requestId: string) {
  await db
    .update(accountDeletionRequests)
    .set({
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
    })
    .where(eq(accountDeletionRequests.id, requestId));
}

export async function markDeletionCompleted(requestId: string) {
  await db
    .update(accountDeletionRequests)
    .set({
      status: 'completed',
      completedAt: new Date().toISOString(),
      // The row outlives the account as the deletion receipt; the user's
      // free-text reason does not.
      reason: null,
    })
    .where(eq(accountDeletionRequests.id, requestId));
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

export async function getScheduledDeletions() {
  return db.select().from(accountDeletionRequests).where(dueRequest());
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

/** Return a failed claim to `pending` so the next tick retries it. */
export async function releaseDeletionRequest(requestId: string) {
  await db
    .update(accountDeletionRequests)
    .set({ status: 'pending', processingStartedAt: null })
    .where(
      and(eq(accountDeletionRequests.id, requestId), eq(accountDeletionRequests.status, 'processing')),
    );
}
