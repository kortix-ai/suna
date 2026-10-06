import { eq, and, lte, or, sql } from 'drizzle-orm';
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
    })
    .where(eq(accountDeletionRequests.id, requestId));
}

/** A `processing` claim older than this belongs to a dead worker. */
const STALE_CLAIM_INTERVAL = sql`interval '1 hour'`;

/** Due requests: `pending`, plus `processing` claims a dead worker left behind. */
function dueRequest() {
  return and(
    lte(accountDeletionRequests.scheduledFor, sql`now()`),
    or(
      eq(accountDeletionRequests.status, 'pending'),
      and(
        eq(accountDeletionRequests.status, 'processing'),
        lte(accountDeletionRequests.processingStartedAt, sql`now() - ${STALE_CLAIM_INTERVAL}`),
      ),
    ),
  );
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
