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
import { PgClient } from '../../__tests__/helpers/pg-client';
import {
  accountDeletionRequests,
  accountMembers,
  accounts,
  creditAccounts,
  gatewayRequestLogs,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { insertIntoView } from '../../__tests__/helpers/compat-views';

const stripeCancel = mock(async (_id: string) => ({}));
const deleteUser = mock(async (_id: string): Promise<{ error: null | { status: number } }> => ({ error: null }));

const realStripe = await import('../../shared/stripe');
const realSupabase = await import('../../shared/supabase');
mock.module('../../shared/stripe', () => ({ ...realStripe, getStripe: () => ({ subscriptions: { cancel: stripeCancel } }) }));
mock.module('../../shared/supabase', () => ({
  ...realSupabase,
  // Session files: an empty bucket (account erasure lists each project).
  getSupabase: () => ({ auth: { admin: { deleteUser } }, storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) } }),
}));

const { db } = await import('../../shared/db');
const { processScheduledDeletions, deleteAccountImmediately } = await import('./account-deletion');
const { claimDeletionRequest } = await import('../repositories/account-deletion');
const { config } = await import('../../config');
const { SWEEP_BATCH_SIZE } = await import('./account-deletion');

const superuser = new PgClient({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
const past = () => new Date(Date.now() - 60_000).toISOString();

/**
 * A requester and the account they asked to delete. By default the account is
 * their personal account, whose id is the user id (`bootstrapPersonalAccount`).
 * `team` seeds an account with its own id; `requester` files the request as
 * someone who is not a member at all.
 */
async function seed(opts: { logs?: number; subscription?: boolean; team?: boolean; requester?: string; scheduledFor?: string } = {}) {
  const userId = crypto.randomUUID();
  const accountId = opts.team ? crypto.randomUUID() : userId;
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
    .values({ accountId, userId: opts.requester ?? userId, scheduledFor: opts.scheduledFor ?? past(), status: 'pending' })
    .returning();
  return { accountId, userId, requestId: request!.id };
}

/** A user's personal account with one running session. */
async function seedRunningPersonalAccount() {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.insert(accounts).values({ accountId: userId, name: 'bystander' });
  await insertIntoView(db, accountMembers, [{ userId, accountId: userId, accountRole: 'owner' }]);
  await db.insert(projects).values({ projectId, accountId: userId, name: 'p1', repoUrl: 'https://example.com/b.git' });
  await db.insert(projectSessions).values({
    sessionId,
    projectId,
    accountId: userId,
    branchName: `session/${sessionId}`,
    createdBy: userId,
    status: 'running',
  });
  return { userId, sessionId };
}
const sessionStatus = async (id: string) =>
  (await db.select().from(projectSessions).where(eq(projectSessions.sessionId, id)))[0]?.status;

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

  test('an account whose session box has an established identity is deleted', async () => {
    // kortix.guard_session_sandbox_identity() refuses to delete a session_sandboxes
    // row that has an external_id unless its session is soft-deleted.
    const { accountId, requestId } = await seed();
    const [project] = await db.select().from(projects).where(eq(projects.accountId, accountId));
    const sessionId = crypto.randomUUID();
    await db.insert(projectSessions).values({
      sessionId,
      projectId: project!.projectId,
      accountId,
      branchName: `session/${sessionId}`,
      createdBy: accountId,
      status: 'stopped',
    });
    await db.insert(sessionSandboxes).values({
      sandboxId: crypto.randomUUID(),
      sessionId,
      accountId,
      projectId: project!.projectId,
      provider: 'daytona',
      externalId: `ext-${sessionId}`,
      status: 'stopped',
    });

    const result = await processScheduledDeletions();

    expect(result.errors).toEqual([]);
    expect(await accountExists(accountId)).toBe(false);
    expect(await requestStatus(requestId)).toBe('completed');
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

describe('whose login goes', () => {
  // Deleting a team account is not deleting the person: the owner keeps their
  // login and the sessions of their other accounts.
  test('a team account is deleted; its owner keeps their login and other accounts', async () => {
    const owner = await seedRunningPersonalAccount();
    const { accountId, requestId } = await seed({ team: true, requester: owner.userId });
    await insertIntoView(db, accountMembers, [{ userId: owner.userId, accountId, accountRole: 'owner' }]);

    const result = await processScheduledDeletions();

    expect(result.errors).toEqual([]);
    expect(await accountExists(accountId)).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(await accountExists(owner.userId)).toBe(true);
    expect(await sessionStatus(owner.sessionId)).toBe('running');
    expect(await requestStatus(requestId)).toBe('completed');
  });

  // A request an operator filed while acting as the customer names the
  // operator as its requester. It deletes the customer's account and never
  // the operator's login or sessions.
  test("a request filed by a non-member never deletes the requester's login or sessions", async () => {
    const operator = await seedRunningPersonalAccount();
    const { accountId, requestId } = await seed({ requester: operator.userId });

    const result = await processScheduledDeletions();

    expect(result.errors).toEqual([]);
    expect(await accountExists(accountId)).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(await accountExists(operator.userId)).toBe(true);
    expect(await sessionStatus(operator.sessionId)).toBe('running');
    expect(await requestStatus(requestId)).toBe('completed');
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
    // Due now, not after a grace period. The trigger stamps the database's
    // now(), and the Docker VM clock can run tens of ms ahead of this process.
    const { rows: [clock] } = await superuser.query('select now() as now');
    expect(new Date(request!.scheduledFor).getTime()).toBeLessThanOrEqual(new Date(clock.now).getTime());

    // The auth user is already gone: the sweep treats "user not found" as done.
    deleteUser.mockImplementation(async () => ({ error: { status: 404 } }));
    const result = await processScheduledDeletions();
    expect(result.errors).toEqual([]);
    expect(await accountExists(accountId)).toBe(false);
    expect(await requestStatus(request!.id)).toBe('completed');
  });
});

describe('sweep guard', () => {
  test('one tick takes at most SWEEP_BATCH_SIZE requests, oldest first', async () => {
    // Drain earlier tests' due rows so the batch below is the only one.
    await db.execute(sql`UPDATE kortix.account_deletion_requests SET status = 'cancelled' WHERE status = 'pending'`);
    const total = SWEEP_BATCH_SIZE + 2;
    const seeded = [];
    for (let i = 0; i < total; i++) {
      // i = 0 is the oldest; all stay inside the overdue window.
      seeded.push(await seed({ subscription: false, scheduledFor: new Date(Date.now() - (total - i) * 60_000 - 60_000).toISOString() }));
    }

    const result = await processScheduledDeletions();

    expect(result.processed).toBe(SWEEP_BATCH_SIZE);
    for (const [i, row] of seeded.entries()) {
      expect(await requestStatus(row.requestId)).toBe(i < SWEEP_BATCH_SIZE ? 'completed' : 'pending');
    }
    // The next tick takes the rest.
    expect((await processScheduledDeletions()).processed).toBe(2);
  }, 60_000);

  test('ACCOUNT_DELETION_SWEEP_PAUSED skips the scheduled sweep; immediate deletion still runs', async () => {
    const scheduled = await seed();
    const immediate = await seed();
    (config as { ACCOUNT_DELETION_SWEEP_PAUSED: boolean }).ACCOUNT_DELETION_SWEEP_PAUSED = true;
    try {
      expect(await processScheduledDeletions()).toEqual({ processed: 0, errors: [] });
      expect(await requestStatus(scheduled.requestId)).toBe('pending');
      expect(await accountExists(scheduled.accountId)).toBe(true);
      expect(stripeCancel).not.toHaveBeenCalled();

      await deleteAccountImmediately(immediate.accountId, immediate.userId);
      expect(await accountExists(immediate.accountId)).toBe(false);
    } finally {
      (config as { ACCOUNT_DELETION_SWEEP_PAUSED: boolean }).ACCOUNT_DELETION_SWEEP_PAUSED = false;
    }
    expect((await processScheduledDeletions()).processed).toBeGreaterThanOrEqual(1);
    expect(await requestStatus(scheduled.requestId)).toBe('completed');
  });
});

describe('legacy basejump references to the auth user', () => {
  // Prod and dev still carry the legacy `basejump` schema and public tables
  // whose NO ACTION foreign keys block GoTrue's delete of auth.users. The
  // migrated test database has none of them, so this block builds the same FK
  // shape (verified against dev's catalog) and drives the real routine.
  beforeAll(async () => {
    await superuser.query(`
      create schema if not exists basejump;
      create table if not exists basejump.accounts (
        id uuid primary key default gen_random_uuid(),
        primary_owner_user_id uuid not null references auth.users(id),
        personal_account boolean not null default false,
        created_by uuid references auth.users(id),
        updated_by uuid references auth.users(id));
      create table if not exists basejump.invitations (
        id uuid primary key default gen_random_uuid(),
        invited_by_user_id uuid not null references auth.users(id));
      create table if not exists public.agent_versions (
        id uuid primary key default gen_random_uuid(),
        created_by uuid references basejump.accounts(id));
      create table if not exists public.google_oauth_tokens (
        id uuid primary key default gen_random_uuid(),
        user_id uuid references auth.users(id));
      create table if not exists public.user_roles (
        id uuid primary key default gen_random_uuid(),
        granted_by uuid references auth.users(id));
      create table if not exists public.admin_actions_log (
        id uuid primary key default gen_random_uuid(),
        admin_user_id uuid not null references auth.users(id));
      grant all on schema basejump to postgres;
      grant all on all tables in schema basejump to postgres;
      grant all on public.agent_versions, public.google_oauth_tokens, public.user_roles, public.admin_actions_log to postgres;`);
  });

  /** GoTrue's delete: a real DELETE on auth.users that FK violations can refuse. */
  function realAuthDelete() {
    deleteUser.mockImplementation(async (id: string) => {
      try {
        await superuser.query(`delete from auth.users where id = $1`, [id]);
        return { error: null };
      } catch {
        return { error: { status: 500 } };
      }
    });
  }
  const authUserCount = async (id: string) =>
    Number((await superuser.query(`select count(*)::int n from auth.users where id = $1`, [id])).rows[0].n);

  async function seedLegacy(userId: string, opts: { teamOwned?: boolean } = {}) {
    const other = crypto.randomUUID();
    await superuser.query(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [
      userId, `${userId}@example.test`, other, `${other}@example.test`,
    ]);
    const personal = (await superuser.query(
      `insert into basejump.accounts (primary_owner_user_id, personal_account) values ($1, true) returning id`, [userId],
    )).rows[0].id as string;
    if (opts.teamOwned) {
      await superuser.query(`insert into basejump.accounts (primary_owner_user_id, personal_account) values ($1, false)`, [userId]);
    }
    await superuser.query(`insert into public.agent_versions (created_by) values ($1)`, [personal]);
    await superuser.query(`insert into basejump.invitations (invited_by_user_id) values ($1)`, [userId]);
    await superuser.query(`insert into public.google_oauth_tokens (user_id) values ($1)`, [userId]);
    // Someone else's rows that point at this user: kept, reference cleared.
    await superuser.query(`insert into public.user_roles (granted_by) values ($1)`, [userId]);
    await superuser.query(`insert into basejump.accounts (primary_owner_user_id, personal_account, created_by) values ($1, true, $2)`, [other, userId]);
    return { personal, other };
  }

  test('removes the personal basejump account and clears every NO ACTION reference, so the auth delete succeeds', async () => {
    realAuthDelete();
    const { accountId, userId, requestId } = await seed({ subscription: false });
    const { personal, other } = await seedLegacy(userId);

    const result = await processScheduledDeletions();

    expect(result.errors).toEqual([]);
    expect(await authUserCount(userId)).toBe(0);
    expect(await requestStatus(requestId)).toBe('completed');
    expect(await accountExists(accountId)).toBe(false);
    const count = async (sqlText: string, args: unknown[]) =>
      Number((await superuser.query(sqlText, args)).rows[0].n);
    expect(await count(`select count(*)::int n from basejump.accounts where id = $1`, [personal])).toBe(0);
    expect(await count(`select count(*)::int n from public.agent_versions where created_by = $1`, [personal])).toBe(0);
    expect(await count(`select count(*)::int n from basejump.invitations where invited_by_user_id = $1`, [userId])).toBe(0);
    expect(await count(`select count(*)::int n from public.google_oauth_tokens where user_id = $1`, [userId])).toBe(0);
    // Another user's rows survive with the reference nulled.
    expect(await count(`select count(*)::int n from basejump.accounts where primary_owner_user_id = $1 and created_by is null`, [other])).toBe(1);
    expect(await count(`select count(*)::int n from public.user_roles where granted_by is null`, [])).toBeGreaterThanOrEqual(1);
  });

  test('refuses to delete the login while the user owns a non-personal basejump account', async () => {
    realAuthDelete();
    const { userId, requestId } = await seed({ subscription: false });
    await seedLegacy(userId, { teamOwned: true });

    const result = await processScheduledDeletions();

    // Earlier refusals stay pending and retry too: assert this user's error.
    expect(result.errors.some((e) => e.includes(userId) && e.includes('basejump'))).toBe(true);
    expect(await authUserCount(userId)).toBe(1);
    expect(await requestStatus(requestId)).toBe('pending');
    expect(
      Number((await superuser.query(`select count(*)::int n from basejump.accounts where primary_owner_user_id = $1 and not personal_account`, [userId])).rows[0].n),
    ).toBe(1);
  });

  test('refuses while the user is the actor of an admin audit row', async () => {
    realAuthDelete();
    const { userId, requestId } = await seed({ subscription: false });
    await seedLegacy(userId);
    await superuser.query(`insert into public.admin_actions_log (admin_user_id) values ($1)`, [userId]);

    const result = await processScheduledDeletions();

    expect(result.errors.some((e) => e.includes(userId) && e.includes('admin_actions_log'))).toBe(true);
    expect(await authUserCount(userId)).toBe(1);
    expect(await requestStatus(requestId)).toBe('pending');
  });
});
