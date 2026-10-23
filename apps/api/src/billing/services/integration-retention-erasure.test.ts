// The account retention backstop on PostgreSQL: which closures it selects,
// what dry_run and execute do to them, and the evidence row each decision
// leaves. Synthetic accounts only.
import { describe, expect, mock, test } from 'bun:test';
import { accountDeletionRequests, accounts, creditAccounts, retentionErasures } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

let deletedAuthUsers: string[] = [];
let failAuthDeleteFor = new Set<string>();

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({ subscriptions: { cancel: async () => ({}) } }),
}));

mock.module('../../shared/supabase', () => ({
  toPublicStorageUrl: (url: string) => url,
  getSupabase: () => ({
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          if (failAuthDeleteFor.has(id)) return { error: { status: 500, message: 'auth delete failed' } };
          deletedAuthUsers.push(id);
          return { error: null };
        },
      },
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
  }),
}));

const { processRetentionErasures } = await import('./retention-erasure');

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const DAY = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** A personal account (id = owner user id) with one deletion request. */
async function closure(opts: { closedDaysAgo: number; status?: string; paid?: boolean }) {
  const accountId = crypto.randomUUID();
  await db.insert(accounts).values({ accountId, name: 'retention-test' });
  if (opts.paid) {
    await db.insert(creditAccounts).values({ accountId, tier: 'credits', paymentStatus: 'active' });
  }
  const [request] = await db
    .insert(accountDeletionRequests)
    .values({
      accountId,
      userId: accountId,
      status: opts.status ?? 'pending',
      requestedAt: daysAgo(opts.closedDaysAgo + 14),
      scheduledFor: daysAgo(opts.closedDaysAgo),
    })
    .returning();
  return { accountId, requestId: request!.id };
}

const accountExists = async (id: string) =>
  (await db.select().from(accounts).where(eq(accounts.accountId, id))).length === 1;
const requestStatus = async (id: string) =>
  (await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, id)))[0]?.status;
const evidence = async (accountId: string) =>
  db.select().from(retentionErasures).where(eq(retentionErasures.accountId, accountId));

withDb('retention erasure backstop — real PostgreSQL', () => {
  test('dry_run records would_erase and skipped_live, deletes nothing, and is idempotent per day', async () => {
    const due = await closure({ closedDaysAgo: 81 });
    const young = await closure({ closedDaysAgo: 30 });
    const cancelled = await closure({ closedDaysAgo: 120, status: 'cancelled' });
    const live = await closure({ closedDaysAgo: 100, paid: true });

    const result = await processRetentionErasures({ mode: 'dry_run', afterDays: 80 });
    expect(result).toEqual({ selected: 2, would_erase: 1, erased: 0, failed: 0, skipped_live: 1 });

    expect(await accountExists(due.accountId)).toBe(true);
    expect(await requestStatus(due.requestId)).toBe('pending');
    const [row] = await evidence(due.accountId);
    expect(row).toMatchObject({ requestId: due.requestId, mode: 'dry_run', outcome: 'would_erase', error: null });
    expect(new Date(row!.closedAt).getTime()).toBeCloseTo(Date.parse(daysAgo(81)), -4);
    expect((await evidence(live.accountId)).map((r) => r.outcome)).toEqual(['skipped_live']);
    expect(await evidence(young.accountId)).toEqual([]);
    expect(await evidence(cancelled.accountId)).toEqual([]);

    // Same UTC day, same mode: nothing is selected again.
    const again = await processRetentionErasures({ mode: 'dry_run', afterDays: 80 });
    expect(again.selected).toBe(0);
  }, 30_000);

  test('execute erases a due closure through the deletion routine and keeps the evidence row', async () => {
    deletedAuthUsers = [];
    const due = await closure({ closedDaysAgo: 85 });
    const live = await closure({ closedDaysAgo: 85, paid: true });

    const result = await processRetentionErasures({ mode: 'execute', afterDays: 80 });
    expect(result.erased).toBeGreaterThanOrEqual(1);

    expect(await accountExists(due.accountId)).toBe(false);
    expect(await requestStatus(due.requestId)).toBe('completed');
    expect(deletedAuthUsers).toContain(due.accountId);
    expect((await evidence(due.accountId)).map((r) => [r.mode, r.outcome])).toEqual([['execute', 'erased']]);

    expect(await accountExists(live.accountId)).toBe(true);
    expect(await requestStatus(live.requestId)).toBe('pending');
    expect((await evidence(live.accountId)).map((r) => r.outcome)).toEqual(['skipped_live']);
  }, 30_000);

  test('a failed run records failed and returns the request to pending; the next day retries the partial erasure', async () => {
    deletedAuthUsers = [];
    const due = await closure({ closedDaysAgo: 90 });
    failAuthDeleteFor = new Set([due.accountId]);
    const result = await processRetentionErasures({ mode: 'execute', afterDays: 80 });
    expect(result.failed).toBe(1);
    expect(await requestStatus(due.requestId)).toBe('pending');
    // The routine deletes the data before the login: the account row is gone, the login is not.
    expect(await accountExists(due.accountId)).toBe(false);
    const [failed] = await evidence(due.accountId);
    expect(failed).toMatchObject({ mode: 'execute', outcome: 'failed', error: 'auth delete failed' });

    failAuthDeleteFor = new Set();
    const tomorrow = new Date(Date.now() + DAY);
    const retry = await processRetentionErasures({ mode: 'execute', afterDays: 80, now: tomorrow });
    // The two live closures of the earlier tests are decided again on the new day.
    expect(retry).toMatchObject({ erased: 1, failed: 0, skipped_live: 2 });
    expect(await requestStatus(due.requestId)).toBe('completed');
    expect(deletedAuthUsers).toEqual([due.accountId]);
    expect((await evidence(due.accountId)).map((r) => r.outcome).sort()).toEqual(['erased', 'failed']);
  }, 30_000);
});
