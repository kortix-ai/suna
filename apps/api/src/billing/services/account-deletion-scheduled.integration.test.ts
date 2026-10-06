// Scheduled account deletions execute end to end on PostgreSQL: a pending
// request past its grace is processed (sandbox sweep is a no-op for an
// account with no boxes, the Stripe subscription is cancelled, the remaining
// balance is forfeited, the billing status is torn down) and the request row
// is marked completed, while future and cancelled requests are left alone and
// the requester's auth identity is preserved. The seeded-due-row acceptance
// proof for KRTX-1260: before this change no processor read the managed
// `kortix.account_deletion_requests` table at all.
import { describe, expect, mock, test } from 'bun:test';
import { accountDeletionRequests, creditAccounts, creditLedger } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../shared/db';

let cancelledSubscriptions: string[] = [];
let deletedAuthUsers: string[] = [];

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    subscriptions: {
      cancel: async (id: string) => {
        cancelledSubscriptions.push(id);
        return {};
      },
    },
  }),
}));

mock.module('../../shared/supabase', () => ({
  // apps/artifacts.ts imports it; a partial mock without it fails at load.
  toPublicStorageUrl: (url: string) => url,
  getSupabase: () => ({
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          deletedAuthUsers.push(id);
          return { error: null };
        },
      },
    },
  }),
}));

const { processScheduledDeletions } = await import('./account-deletion');

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const DAY = 24 * 3600 * 1000;
const past = new Date(Date.now() - DAY).toISOString();
const future = new Date(Date.now() + 14 * DAY).toISOString();

withDb('scheduled account deletions — real PostgreSQL', () => {
  test('executes a due pending request and leaves future and cancelled ones alone', async () => {
    const accDue = crypto.randomUUID();
    const accFuture = crypto.randomUUID();
    const accCancelled = crypto.randomUUID();
    const userDue = crypto.randomUUID();

    await db.insert(creditAccounts).values({
      accountId: accDue,
      tier: 'pro',
      balance: '5.0000000000',
      stripeSubscriptionId: 'sub_test_1',
      stripeSubscriptionStatus: 'active',
      paymentStatus: 'active',
    });

    const seeded = await db
      .insert(accountDeletionRequests)
      .values([
        { accountId: accDue, userId: userDue, scheduledFor: past, status: 'pending' },
        { accountId: accFuture, userId: userDue, scheduledFor: future, status: 'pending' },
        {
          accountId: accCancelled,
          userId: userDue,
          scheduledFor: past,
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
        },
      ])
      .returning({ id: accountDeletionRequests.id, accountId: accountDeletionRequests.accountId });

    try {
      const result = await processScheduledDeletions();
      expect(result.processed).toBe(1);
      expect(result.errors).toEqual([]);

      const after = await db
        .select()
        .from(accountDeletionRequests)
        .where(inArray(accountDeletionRequests.id, seeded.map((row) => row.id)));
      const byAccount = new Map(after.map((row) => [row.accountId, row]));
      const due = byAccount.get(accDue)!;
      expect(due.status).toBe('completed');
      expect(due.completedAt).not.toBeNull();
      expect(byAccount.get(accFuture)!.status).toBe('pending');
      expect(byAccount.get(accCancelled)!.status).toBe('cancelled');

      const [account] = await db
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.accountId, accDue));
      expect(account!.tier).toBe('free');
      expect(account!.balance).toBe('0.0000000000');
      expect(account!.stripeSubscriptionStatus).toBe('canceled');
      expect(account!.paymentStatus).toBe('deleted');

      const forfeiture = await db
        .select({ amount: creditLedger.amount, type: creditLedger.type })
        .from(creditLedger)
        .where(eq(creditLedger.accountId, accDue));
      expect(forfeiture).toEqual([{ amount: '-5.0000000000', type: 'forfeiture' }]);

      expect(cancelledSubscriptions).toEqual(['sub_test_1']);
      // The pinned scheduled-path semantic: the historical requester's auth
      // identity survives the scheduled deletion (only the immediate path
      // deletes it).
      expect(deletedAuthUsers).toEqual([]);
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.accountId, accDue));
      await db.delete(creditAccounts).where(eq(creditAccounts.accountId, accDue));
      await db
        .delete(accountDeletionRequests)
        .where(inArray(accountDeletionRequests.id, seeded.map((row) => row.id)));
    }
  }, 30_000);
});
