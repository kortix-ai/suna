/**
 * Integration test (real local DB): scheduled and immediate account deletion
 * run ONE routine (data, then the auth user), claim each request atomically,
 * keep a failed run retryable, and the auth-user-delete trigger hands orphan
 * accounts to that routine instead of deleting them itself.
 *
 * Stripe and the Supabase auth admin API are the only fakes; everything else
 * (rows, FK cascade, trigger, claim SQL) is the real schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import {
  accountDeletionRequests,
  accountMembers,
  accounts,
  creditAccounts,
  gatewayRequestLogs,
  projects,
} from '@kortix/db';
import { insertIntoView } from '../../__tests__/helpers/compat-views';

const stripeCancel = mock(async (_id: string) => ({}));
const deleteUser = mock(async (_id: string): Promise<{ error: null | { status: number } }> => ({ error: null }));

const realStripe = await import('../../shared/stripe');
const realSupabase = await import('../../shared/supabase');
mock.module('../../shared/stripe', () => ({ ...realStripe, getStripe: () => ({ subscriptions: { cancel: stripeCancel } }) }));
mock.module('../../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ auth: { admin: { deleteUser } } }) }));

const { db } = await import('../../shared/db');
const { processScheduledDeletions, deleteAccountImmediately } = await import('./account-deletion');
const { claimDeletionRequest } = await import('../repositories/account-deletion');

const superuser = new pg.Client({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
const past = () => new Date(Date.now() - 60_000).toISOString();

async function seed(opts: { logs?: number; subscription?: boolean } = {}) {
  const accountId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await db.insert(accounts).values({ accountId, name: 'deletion-test' });
  await db.insert(projects).values({
    projectId: crypto.randomUUID(),
    accountId,
    name: 'p1',
    repoUrl: 'https://example.com/p1.git',
  });
  await db.insert(creditAccounts).values({
    accountId,
    balance: '5',
    ...(opts.subscription === false ? {} : { stripeSubscriptionId: `sub_${accountId}` }),
  });
  await insertIntoView(db, accountMembers, [{ userId, accountId, accountRole: 'owner' }]);
  if (opts.logs) {
    await db.execute(sql`
      INSERT INTO kortix.gateway_request_logs
        (request_id, account_id, requested_model, resolved_model, provider, status, ok)
      SELECT 'r' || g, ${accountId}::uuid, 'm', 'm', 'p', 200, true FROM generate_series(1, ${opts.logs}) g`);
  }
  const [request] = await db
    .insert(accountDeletionRequests)
    .values({ accountId, userId, scheduledFor: past(), status: 'pending' })
    .returning();
  return { accountId, userId, requestId: request!.id };
}

const accountExists = async (id: string) =>
  (await db.select().from(accounts).where(eq(accounts.accountId, id))).length === 1;
const requestStatus = async (id: string) =>
  (await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, id)))[0]?.status;
const logCount = async (id: string) =>
  (await db.select().from(gatewayRequestLogs).where(eq(gatewayRequestLogs.accountId, id))).length;

beforeAll(async () => {
  await superuser.connect();
});
afterAll(async () => {
  await superuser.end();
});
beforeEach(() => {
  stripeCancel.mockClear();
  deleteUser.mockClear();
  stripeCancel.mockImplementation(async () => ({}));
  deleteUser.mockImplementation(async () => ({ error: null }));
});

describe('scheduled deletion', () => {
  test('deletes data across chunk boundaries, then the auth user, and keeps the receipt', async () => {
    const { accountId, userId, requestId } = await seed({ logs: 5_001 });
    expect(await logCount(accountId)).toBe(5_001);

    const result = await processScheduledDeletions();

    expect(result.errors).toEqual([]);
    expect(await accountExists(accountId)).toBe(false);
    expect(await logCount(accountId)).toBe(0);
    expect(stripeCancel).toHaveBeenCalledWith(`sub_${accountId}`);
    expect(deleteUser).toHaveBeenCalledWith(userId);
    expect(await requestStatus(requestId)).toBe('completed');
    const [credit] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    expect(credit?.paymentStatus).toBe('deleted');
  });

  test('a failed Stripe cancel leaves the account intact and the request retryable', async () => {
    const { accountId, requestId } = await seed();
    stripeCancel.mockImplementationOnce(async () => {
      throw new Error('stripe down');
    });

    const first = await processScheduledDeletions();
    expect(first.errors.length).toBe(1);
    expect(await accountExists(accountId)).toBe(true);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(await requestStatus(requestId)).toBe('pending');

    const second = await processScheduledDeletions();
    expect(second.errors).toEqual([]);
    expect(await accountExists(accountId)).toBe(false);
    expect(await requestStatus(requestId)).toBe('completed');
  });

  test('a failed auth user delete leaves the request retryable; the retry completes it', async () => {
    const { accountId, requestId } = await seed();
    deleteUser.mockImplementationOnce(async () => ({ error: { status: 500 } }));

    await processScheduledDeletions();
    expect(await requestStatus(requestId)).toBe('pending');

    await processScheduledDeletions();
    expect(await accountExists(accountId)).toBe(false);
    expect(await requestStatus(requestId)).toBe('completed');
  });

  test('two concurrent workers run the irreversible steps once', async () => {
    const { accountId, requestId } = await seed();

    await Promise.all([processScheduledDeletions(), processScheduledDeletions()]);

    expect(stripeCancel).toHaveBeenCalledTimes(1);
    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(await accountExists(accountId)).toBe(false);
    expect(await requestStatus(requestId)).toBe('completed');
  });

  test('a request cancelled after the batch was loaded is not claimed', async () => {
    const { requestId } = await seed();
    await db.update(accountDeletionRequests).set({ status: 'cancelled' }).where(eq(accountDeletionRequests.id, requestId));

    expect(await claimDeletionRequest(requestId)).toBeNull();
  });

  test('a stale processing claim is reclaimed; a fresh one is not', async () => {
    const { requestId } = await seed();
    await db
      .update(accountDeletionRequests)
      .set({ status: 'processing', processingStartedAt: sql`now()` })
      .where(eq(accountDeletionRequests.id, requestId));
    expect(await claimDeletionRequest(requestId)).toBeNull();

    await db
      .update(accountDeletionRequests)
      .set({ processingStartedAt: sql`now() - interval '2 hours'` })
      .where(eq(accountDeletionRequests.id, requestId));
    expect((await claimDeletionRequest(requestId))?.status).toBe('processing');
  });
});

describe('immediate deletion', () => {
  test('runs the same routine: data, then the auth user', async () => {
    const { accountId, userId, requestId } = await seed({ logs: 3 });

    await deleteAccountImmediately(accountId, userId);

    expect(await accountExists(accountId)).toBe(false);
    expect(deleteUser).toHaveBeenCalledWith(userId);
    expect(stripeCancel).toHaveBeenCalledTimes(1);
    expect(await requestStatus(requestId)).toBe('completed');
  });
});

describe('auth-user-delete trigger', () => {
  test('schedules the orphan account for the sweep instead of deleting it', async () => {
    const userId = crypto.randomUUID();
    const accountId = userId;
    await superuser.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `${userId}@example.test`]);
    await db.insert(accounts).values({ accountId, name: 'orphan' });
    await db.insert(creditAccounts).values({ accountId, balance: '0' });
    await insertIntoView(db, accountMembers, [{ userId, accountId, accountRole: 'owner' }]);

    await superuser.query(`delete from auth.users where id = $1`, [userId]);

    expect(await accountExists(accountId)).toBe(true);
    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, accountId));
    expect(request?.status).toBe('pending');
    expect(new Date(request!.scheduledFor).getTime()).toBeLessThanOrEqual(Date.now());

    // The auth user is already gone: the sweep treats "user not found" as done.
    deleteUser.mockImplementation(async () => ({ error: { status: 404 } }));
    const result = await processScheduledDeletions();
    expect(result.errors).toEqual([]);
    expect(await accountExists(accountId)).toBe(false);
    expect(await requestStatus(request!.id)).toBe('completed');
  });
});
