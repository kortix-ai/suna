import { eq, and, lte, ne } from 'drizzle-orm';
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

export async function getScheduledDeletions() {
  const now = new Date().toISOString();

  const rows = await db
    .select()
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.status, 'pending'),
        lte(accountDeletionRequests.scheduledFor, now),
      ),
    );

  return rows;
}
