/**
 * Workspace identity against real PostgreSQL (the DB-suite runner applies
 * every migration): the `kortix.workspaces` table and its reconcile triggers,
 * the live-row rule, the `split_pending` trigger, the expand columns, shadow
 * reads, the two resolvers, the 1:1 unique index, the 409 every project
 * create path runs, the name mirror, and the workspace lifecycle (close,
 * restore).
 *
 * Runs against `TEST_DATABASE_URL`; every row is synthetic, seeded and
 * cleaned here. See `.agents/skills/testing/SKILL.md` "DB suites".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accountDeletionRequests, accountMemberships, accounts, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '../shared/db';
import { projectCreationDenial } from '../projects/lib/project-quota';
import { asWorkspaceId } from './ids';
import { closeWorkspace, restoreWorkspace } from './lifecycle';
import { isWorkspaceOnePerAccountConflict, WORKSPACE_HAS_PROJECT_CODE } from './one-project';
import { resolveCanonicalWorkspace, resolveWorkspace, WorkspaceAmbiguousError } from './resolve';
import { shadowMismatchCount } from './shadow';
import { checkWorkspaceInvariants } from './split/invariants';
import { getWorkspace, listUserWorkspaceCandidates, workspaceIdOfAccount } from './store';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
  process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

// Fixed uuids so a crashed previous run is still cleaned up.
const ONE_ACCOUNT = '00000000-0000-4000-a000-00000000d101';
const LEGACY_ACCOUNT = '00000000-0000-4000-a000-00000000d102';
const EMPTY_ACCOUNT = '00000000-0000-4000-a000-00000000d103';
const NEW_ACCOUNT = '00000000-0000-4000-a000-00000000d104';
const ONE_PROJECT = '00000000-0000-4000-a000-00000000d201';
const LEGACY_P1 = '00000000-0000-4000-a000-00000000d202';
const LEGACY_P2 = '00000000-0000-4000-a000-00000000d203';
const ARCHIVED_PROJECT = '00000000-0000-4000-a000-00000000d204';
const NEW_PROJECT = '00000000-0000-4000-a000-00000000d208';
const OWNER = '00000000-0000-4000-a000-00000000d301';
const ACCOUNTS = [ONE_ACCOUNT, LEGACY_ACCOUNT, EMPTY_ACCOUNT, NEW_ACCOUNT];

function projectValues(projectId: string, accountId: string, name: string, extra: Partial<typeof projects.$inferInsert> = {}) {
  return {
    projectId,
    accountId,
    name,
    repoUrl: `https://example.invalid/${projectId}.git`,
    ...extra,
  };
}

async function cleanup(): Promise<void> {
  await db.delete(accountDeletionRequests).where(inArray(accountDeletionRequests.accountId, ACCOUNTS));
  await db.delete(accountMemberships).where(inArray(accountMemberships.accountId, ACCOUNTS));
  await db.delete(accounts).where(inArray(accounts.accountId, ACCOUNTS));
}

async function seed(): Promise<void> {
  await cleanup();
  await db.insert(accounts).values([
    { accountId: ONE_ACCOUNT, name: 'Synthetic one' },
    { accountId: LEGACY_ACCOUNT, name: 'Synthetic legacy' },
    { accountId: EMPTY_ACCOUNT, name: 'Synthetic empty' },
  ]);
  await db.insert(projects).values([
    projectValues(ONE_PROJECT, ONE_ACCOUNT, 'Synthetic one'),
    projectValues(ARCHIVED_PROJECT, ONE_ACCOUNT, 'Synthetic archived', { status: 'archived' }),
    // A legacy multi-project account: both active projects are split-pending.
    projectValues(LEGACY_P1, LEGACY_ACCOUNT, 'Synthetic legacy 1', { splitPending: true }),
    projectValues(LEGACY_P2, LEGACY_ACCOUNT, 'Synthetic legacy 2', { splitPending: true }),
  ]);
}

/** The table rows of the seeded accounts, keyed by workspace id. */
async function tableRows(): Promise<Record<string, { lifecycle: string; account: string | null; former: string | null; split: boolean }>> {
  const rows = await db.execute<{ workspace_id: string; lifecycle: string; legacy_account_id: string | null; former_account_id: string | null; split_pending: boolean }>(sql`
    SELECT workspace_id::text, lifecycle, legacy_account_id::text, former_account_id::text, split_pending
      FROM kortix.workspaces
     WHERE legacy_account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(ACCOUNTS)}::jsonb))
        OR former_account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(ACCOUNTS)}::jsonb))`);
  return Object.fromEntries(
    rows.map((r) => [r.workspace_id, { lifecycle: r.lifecycle, account: r.legacy_account_id, former: r.former_account_id, split: r.split_pending }]),
  );
}

/** I9 for the seeded accounts only: table rows that differ from workspaces_expected. */
async function i9Seeded(): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT a.id FROM (SELECT jsonb_array_elements_text(${JSON.stringify(ACCOUNTS)}::jsonb)::uuid AS id) a
       WHERE EXISTS (
         (SELECT to_jsonb(e) - 'synced_at' FROM kortix.workspaces_expected(a.id) e
          EXCEPT SELECT to_jsonb(w) - 'synced_at' FROM kortix.workspaces w WHERE w.legacy_account_id = a.id OR w.former_account_id = a.id)
         UNION ALL
         (SELECT to_jsonb(w) - 'synced_at' FROM kortix.workspaces w WHERE w.legacy_account_id = a.id OR w.former_account_id = a.id
          EXCEPT SELECT to_jsonb(e) - 'synced_at' FROM kortix.workspaces_expected(a.id) e))) x`);
  return row?.n ?? -1;
}

async function accountName(accountId: string): Promise<string | undefined> {
  const [row] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, accountId));
  return row?.name;
}

async function projectName(projectId: string): Promise<string | undefined> {
  const [row] = await db.select({ name: projects.name }).from(projects).where(eq(projects.projectId, projectId));
  return row?.name;
}

/** The error a statement throws, or null. */
async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

withDb('workspaces identity', () => {
  beforeEach(seed);
  afterEach(cleanup);

  test('the unique index uq_projects_workspace_account exists and is valid', async () => {
    const rows = await db.execute<{ valid: boolean; unique: boolean }>(sql`
      select i.indisvalid as valid, i.indisunique as unique
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'uq_projects_workspace_account' and c.relnamespace = 'kortix'::regnamespace`);
    expect(rows[0]).toEqual({ valid: true, unique: true });
  });

  test('the triggers keep kortix.workspaces equal to the live-row rule', async () => {
    expect(await tableRows()).toEqual({
      [ONE_PROJECT]: { lifecycle: 'active', account: ONE_ACCOUNT, former: null, split: false },
      // An archived project of an account with an active one: a tombstone.
      [ARCHIVED_PROJECT]: { lifecycle: 'tombstone', account: null, former: ONE_ACCOUNT, split: false },
      [LEGACY_P1]: { lifecycle: 'active', account: LEGACY_ACCOUNT, former: null, split: true },
      [LEGACY_P2]: { lifecycle: 'active', account: LEGACY_ACCOUNT, former: null, split: true },
      // An account with no project row: its project-less row, workspace_id = account_id.
      [EMPTY_ACCOUNT]: { lifecycle: 'dormant', account: EMPTY_ACCOUNT, former: null, split: false },
    });
    expect(await i9Seeded()).toBe(0);
  });

  test('a deletion request turns the live row closing; its cancel turns it back', async () => {
    const [request] = await db
      .insert(accountDeletionRequests)
      .values({ accountId: ONE_ACCOUNT, userId: OWNER, scheduledFor: new Date(Date.now() + 86_400_000).toISOString() })
      .returning({ id: accountDeletionRequests.id });
    expect((await getWorkspace(ONE_PROJECT))?.lifecycle).toBe('closing');
    expect((await getWorkspace(ONE_PROJECT))?.deletionScheduledFor).toBeInstanceOf(Date);
    // Archive the project too (the archive bumps updated_at): the most
    // recently archived row stays live and keeps the id.
    await db.update(projects).set({ status: 'archived', updatedAt: new Date() }).where(eq(projects.projectId, ONE_PROJECT));
    expect((await tableRows())[ONE_PROJECT]?.lifecycle).toBe('closing');
    await db.update(projects).set({ status: 'active' }).where(eq(projects.projectId, ONE_PROJECT));
    await db.update(accountDeletionRequests).set({ status: 'cancelled' }).where(eq(accountDeletionRequests.id, request!.id));
    expect((await getWorkspace(ONE_PROJECT))?.lifecycle).toBe('active');
    expect(await i9Seeded()).toBe(0);
  });

  test('a new account is dormant; its first project takes over and re-stamps the expand rows', async () => {
    await db.insert(accounts).values({ accountId: NEW_ACCOUNT, name: 'Synthetic new' });
    await db.insert(accountMemberships).values({ accountId: NEW_ACCOUNT, userId: OWNER });
    const stamp = async () =>
      (await db.select({ w: accountMemberships.workspaceId }).from(accountMemberships).where(eq(accountMemberships.accountId, NEW_ACCOUNT)))[0]?.w;
    expect(await stamp()).toBe(NEW_ACCOUNT);
    expect(await workspaceIdOfAccount(NEW_ACCOUNT)).toBe(asWorkspaceId(NEW_ACCOUNT));
    await db.insert(projects).values(projectValues(NEW_PROJECT, NEW_ACCOUNT, 'Synthetic new'));
    expect(await stamp()).toBe(NEW_PROJECT);
    expect(await workspaceIdOfAccount(NEW_ACCOUNT)).toBe(asWorkspaceId(NEW_PROJECT));
    expect(await getWorkspace(NEW_ACCOUNT)).toBeNull();
    // The legacy account is ambiguous: its rows stay unstamped.
    expect(await workspaceIdOfAccount(LEGACY_ACCOUNT)).toBeNull();
  });

  test('archiving one of two legacy projects clears split_pending; the index guards the account again', async () => {
    await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, LEGACY_P2));
    const [survivor] = await db.select({ split: projects.splitPending }).from(projects).where(eq(projects.projectId, LEGACY_P1));
    expect(survivor?.split).toBe(false);
    expect((await tableRows())[LEGACY_P1]).toEqual({ lifecycle: 'active', account: LEGACY_ACCOUNT, former: null, split: false });
    const error = await errorOf(() =>
      db.insert(projects).values(projectValues('00000000-0000-4000-a000-00000000d209', LEGACY_ACCOUNT, 'Synthetic legacy 3')),
    );
    expect(isWorkspaceOnePerAccountConflict(error)).toBe(true);
  });

  test('shadow reads: a missed trigger answers from the primary, logs the field and breaks I9', async () => {
    const before = shadowMismatchCount('name');
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE kortix.accounts DISABLE TRIGGER accounts_workspaces_sync`);
      await tx.update(accounts).set({ name: 'Synthetic dormant renamed' }).where(eq(accounts.accountId, EMPTY_ACCOUNT));
      await tx.execute(sql`ALTER TABLE kortix.accounts ENABLE TRIGGER accounts_workspaces_sync`);
    });
    expect((await getWorkspace(EMPTY_ACCOUNT))?.name).toBe('Synthetic dormant renamed');
    expect(shadowMismatchCount('name')).toBe(before + 1);
    expect(await i9Seeded()).toBe(1);
    const report = await checkWorkspaceInvariants();
    expect(report.I9.ok).toBe(false);
    expect(report.I9.sample).toContain(EMPTY_ACCOUNT);
    await db.execute(sql`SELECT kortix.workspaces_reconcile_account(${EMPTY_ACCOUNT}::uuid)`);
    expect(await i9Seeded()).toBe(0);
  });

  test('resolveWorkspace (legacy): the project id and the account key resolve to the same workspace', async () => {
    const expected = { workspaceId: ONE_PROJECT, accountId: ONE_ACCOUNT, splitPending: false, lifecycle: 'active', projectId: ONE_PROJECT };
    expect(await resolveWorkspace(ONE_PROJECT)).toEqual(expected as never);
    expect(await resolveWorkspace(ONE_ACCOUNT)).toEqual(expected as never);
  });

  test('resolveWorkspace (legacy): archived, dormant, unknown and non-uuid ids are null', async () => {
    expect(await resolveWorkspace(ARCHIVED_PROJECT)).toBeNull();
    expect(await resolveWorkspace(EMPTY_ACCOUNT)).toBeNull();
    expect(await resolveWorkspace('00000000-0000-4000-a000-00000000dfff')).toBeNull();
    expect(await resolveWorkspace('not-a-uuid')).toBeNull();
  });

  test('resolveWorkspace (legacy): a legacy account key is ambiguous; its project ids resolve', async () => {
    const error = await errorOf(() => resolveWorkspace(LEGACY_ACCOUNT));
    expect(error).toBeInstanceOf(WorkspaceAmbiguousError);
    expect((error as WorkspaceAmbiguousError).code).toBe('workspace_ambiguous');
    expect((await resolveWorkspace(LEGACY_P2))?.workspaceId).toBe(asWorkspaceId(LEGACY_P2));
  });

  test('resolveCanonicalWorkspace: workspace ids only; a dormant workspace resolves, an account key does not', async () => {
    expect((await resolveCanonicalWorkspace(ONE_PROJECT))?.accountId).toBe(ONE_ACCOUNT as never);
    expect(await resolveCanonicalWorkspace(ONE_ACCOUNT)).toBeNull();
    expect(await resolveCanonicalWorkspace(ARCHIVED_PROJECT)).toBeNull();
    expect((await resolveCanonicalWorkspace(EMPTY_ACCOUNT))?.lifecycle).toBe('dormant');
    expect((await resolveCanonicalWorkspace(EMPTY_ACCOUNT.toUpperCase()))?.workspaceId).toBe(asWorkspaceId(EMPTY_ACCOUNT));
  });

  test('listUserWorkspaceCandidates: every live row of every account of the user, with role and paying', async () => {
    await db.insert(accountMemberships).values([
      { accountId: ONE_ACCOUNT, userId: OWNER },
      { accountId: EMPTY_ACCOUNT, userId: OWNER },
    ]);
    const ids = (await listUserWorkspaceCandidates(OWNER)).map((c) => c.record.workspaceId).sort();
    expect(ids).toEqual([ONE_PROJECT, EMPTY_ACCOUNT].map(asWorkspaceId).sort());
    expect((await listUserWorkspaceCandidates(OWNER)).every((c) => c.paying === false)).toBe(true);
  });

  test('a second active project in a 1:1 account fails on the unique index', async () => {
    const error = await errorOf(() =>
      db.insert(projects).values(projectValues('00000000-0000-4000-a000-00000000d205', ONE_ACCOUNT, 'Synthetic second')),
    );
    expect(isWorkspaceOnePerAccountConflict(error)).toBe(true);
  });

  test('projectCreationDenial: 409 workspace_has_project for an account with an active project', async () => {
    const denial = await projectCreationDenial(ONE_ACCOUNT);
    expect(denial?.status).toBe(409);
    expect(denial?.body).toMatchObject({ code: WORKSPACE_HAS_PROJECT_CODE, account_id: ONE_ACCOUNT, workspace_id: ONE_PROJECT });
    expect((await projectCreationDenial(LEGACY_ACCOUNT))?.status).toBe(409);
    expect(await projectCreationDenial(EMPTY_ACCOUNT)).toBeNull();
  });

  test('projectCreationDenial: 409 workspace_deleting for a deleted workspace (finding 1: no create inherits it)', async () => {
    expect((await closeWorkspace({ workspaceId: asWorkspaceId(ONE_PROJECT), actorUserId: OWNER })).mode).toBe('closed');
    const denial = await projectCreationDenial(ONE_ACCOUNT);
    expect(denial?.status).toBe(409);
    expect(denial?.body).toMatchObject({ code: 'workspace_deleting', account_id: ONE_ACCOUNT });
  });

  test('projects_name_sync / accounts_name_sync mirror a 1:1 rename both ways', async () => {
    await db.update(projects).set({ name: 'Synthetic renamed project' }).where(eq(projects.projectId, ONE_PROJECT));
    expect(await accountName(ONE_ACCOUNT)).toBe('Synthetic renamed project');
    await db.update(accounts).set({ name: 'Synthetic renamed account' }).where(eq(accounts.accountId, ONE_ACCOUNT));
    expect(await projectName(ONE_PROJECT)).toBe('Synthetic renamed account');
    expect(await projectName(ARCHIVED_PROJECT)).toBe('Synthetic archived');
    expect((await getWorkspace(ONE_PROJECT))?.name).toBe('Synthetic renamed account');
  });

  // The M2 rollback (header of 20261106153020000_workspaces_mark_and_name):
  // a bare UPDATE fires accounts_name_sync and renames the 1:1 project to the
  // old account name; the documented statement disables that trigger.
  test('the documented M2 name rollback restores account names and keeps project names', async () => {
    const backup = sql`INSERT INTO kortix.workspace_name_backups (account_id, old_name, new_name)
      VALUES (${ONE_ACCOUNT}::uuid, 'Synthetic old account name', 'Synthetic one')
      ON CONFLICT (account_id) DO UPDATE SET old_name = EXCLUDED.old_name, new_name = EXCLUDED.new_name`;
    const bare = sql`UPDATE kortix.accounts a SET name = b.old_name
      FROM kortix.workspace_name_backups b WHERE a.account_id = b.account_id AND a.account_id = ${ONE_ACCOUNT}::uuid`;
    try {
      await db.execute(backup);
      await db.transaction(async (tx) => {
        await tx.execute(bare);
        expect(await tx.execute(sql`SELECT name FROM kortix.projects WHERE project_id = ${ONE_PROJECT}::uuid`))
          .toMatchObject([{ name: 'Synthetic old account name' }]);
        tx.rollback();
      }).catch((err) => {
        if (!(err instanceof Error) || !/rollback/i.test(err.message)) throw err;
      });
      expect(await projectName(ONE_PROJECT)).toBe('Synthetic one');

      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`ALTER TABLE kortix.accounts DISABLE TRIGGER accounts_name_sync`);
        await tx.execute(bare);
        await tx.execute(sql`ALTER TABLE kortix.accounts ENABLE TRIGGER accounts_name_sync`);
      });
      expect(await accountName(ONE_ACCOUNT)).toBe('Synthetic old account name');
      expect(await projectName(ONE_PROJECT)).toBe('Synthetic one');
      await db.update(accounts).set({ name: 'Synthetic after rollback' }).where(eq(accounts.accountId, ONE_ACCOUNT));
      expect(await projectName(ONE_PROJECT)).toBe('Synthetic after rollback');
    } finally {
      await db.execute(sql`DELETE FROM kortix.workspace_name_backups WHERE account_id = ${ONE_ACCOUNT}::uuid`);
    }
  });

  test('a legacy account and its projects keep independent names', async () => {
    await db.update(projects).set({ name: 'Synthetic legacy renamed' }).where(eq(projects.projectId, LEGACY_P1));
    expect(await accountName(LEGACY_ACCOUNT)).toBe('Synthetic legacy');
    await db.update(accounts).set({ name: 'Synthetic legacy account' }).where(eq(accounts.accountId, LEGACY_ACCOUNT));
    expect(await projectName(LEGACY_P2)).toBe('Synthetic legacy 2');
  });

  test('closeWorkspace closes the account with the project; restoreWorkspace brings both back with the same id', async () => {
    const closed = await closeWorkspace({ workspaceId: asWorkspaceId(ONE_PROJECT), actorUserId: OWNER });
    expect(closed.mode).toBe('closed');
    const record = await getWorkspace(ONE_PROJECT);
    expect(record).toMatchObject({ lifecycle: 'closing', workspaceId: ONE_PROJECT, projectStatus: 'archived' });
    expect(record?.automationsPausedAt).toBeInstanceOf(Date);
    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, ONE_ACCOUNT));
    expect(request).toMatchObject({ status: 'pending', reason: 'workspace_deleted' });
    // Idempotent.
    expect((await closeWorkspace({ workspaceId: asWorkspaceId(ONE_PROJECT), actorUserId: OWNER })).mode).toBe('closed');

    const restored = await restoreWorkspace({ workspaceId: asWorkspaceId(ONE_PROJECT), actorUserId: OWNER });
    expect(restored).toMatchObject({ lifecycle: 'active', workspaceId: ONE_PROJECT, projectStatus: 'active', automationsPausedAt: null });
    expect(await i9Seeded()).toBe(0);
  });

  test('closeWorkspace on a split_pending workspace archives its project row only', async () => {
    expect(await closeWorkspace({ workspaceId: asWorkspaceId(LEGACY_P2), actorUserId: OWNER })).toEqual({ mode: 'archived_project' });
    expect(await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, LEGACY_ACCOUNT))).toEqual([]);
    expect((await getWorkspace(LEGACY_P1))?.splitPending).toBe(false);
    expect(await getWorkspace(LEGACY_P2)).toBeNull();
  });

  test('invariants I9, I10 and I12 hold after the scenarios above', async () => {
    await db.insert(accountMemberships).values({ accountId: ONE_ACCOUNT, userId: OWNER });
    const report = await checkWorkspaceInvariants({ accountIds: ACCOUNTS });
    expect(report.I9).toMatchObject({ ok: true });
    expect(report.I10).toMatchObject({ ok: true });
    expect(report.I12).toMatchObject({ ok: true });
  });
});
