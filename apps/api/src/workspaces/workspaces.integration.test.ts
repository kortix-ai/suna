/**
 * Workspace identity against real PostgreSQL (migrations M1–M3 applied by the
 * DB-suite runner): the `kortix.workspaces` view, `resolveWorkspace`, the
 * store, the 1:1 unique index, and the 409 `workspace_has_project` decision
 * every project create path runs (`projectCreationDenial`).
 *
 * Runs against `TEST_DATABASE_URL`; every row is synthetic, seeded and
 * cleaned here. See `.agents/skills/testing/SKILL.md` "DB suites".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, projects, workspaces } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '../shared/db';
import { projectCreationDenial } from '../projects/lib/project-quota';
import { asWorkspaceId } from './ids';
import { isWorkspaceOnePerAccountConflict, WORKSPACE_HAS_PROJECT_CODE } from './one-project';
import { resolveWorkspace, WorkspaceAmbiguousError } from './resolve';
import { getWorkspace, updateWorkspace } from './store';

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
const ONE_PROJECT = '00000000-0000-4000-a000-00000000d201';
const LEGACY_P1 = '00000000-0000-4000-a000-00000000d202';
const LEGACY_P2 = '00000000-0000-4000-a000-00000000d203';
const ARCHIVED_PROJECT = '00000000-0000-4000-a000-00000000d204';
const ACCOUNTS = [ONE_ACCOUNT, LEGACY_ACCOUNT, EMPTY_ACCOUNT];

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

  test('the view has one row per active project; archived projects and empty accounts have none', async () => {
    const rows = await db
      .select({ workspaceId: workspaces.workspaceId, accountId: workspaces.accountId, splitPending: workspaces.splitPending })
      .from(workspaces)
      .where(inArray(workspaces.accountId, ACCOUNTS));
    expect(rows.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
      { workspaceId: ONE_PROJECT, accountId: ONE_ACCOUNT, splitPending: false },
      { workspaceId: LEGACY_P1, accountId: LEGACY_ACCOUNT, splitPending: true },
      { workspaceId: LEGACY_P2, accountId: LEGACY_ACCOUNT, splitPending: true },
    ]);
  });

  test('resolveWorkspace: the project id and the account key resolve to the same workspace', async () => {
    const expected = { workspaceId: ONE_PROJECT, accountId: ONE_ACCOUNT, splitPending: false };
    expect(await resolveWorkspace(ONE_PROJECT)).toEqual(expected as never);
    expect(await resolveWorkspace(ONE_ACCOUNT)).toEqual(expected as never);
  });

  test('resolveWorkspace: archived, dormant, unknown and non-uuid ids are null', async () => {
    expect(await resolveWorkspace(ARCHIVED_PROJECT)).toBeNull();
    expect(await resolveWorkspace(EMPTY_ACCOUNT)).toBeNull();
    expect(await resolveWorkspace('00000000-0000-4000-a000-00000000dfff')).toBeNull();
    expect(await resolveWorkspace('not-a-uuid')).toBeNull();
  });

  test('resolveWorkspace: a legacy account key is ambiguous; its project ids resolve', async () => {
    const error = await errorOf(() => resolveWorkspace(LEGACY_ACCOUNT));
    expect(error).toBeInstanceOf(WorkspaceAmbiguousError);
    expect((error as WorkspaceAmbiguousError).code).toBe('workspace_ambiguous');
    expect([...(error as WorkspaceAmbiguousError).workspaceIds].map(String).sort()).toEqual([LEGACY_P1, LEGACY_P2]);
    expect(await resolveWorkspace(LEGACY_P2)).toEqual({
      workspaceId: LEGACY_P2,
      accountId: LEGACY_ACCOUNT,
      splitPending: true,
    } as never);
  });

  test('a second active project in a 1:1 account fails on the unique index', async () => {
    const error = await errorOf(() =>
      db.insert(projects).values(projectValues('00000000-0000-4000-a000-00000000d205', ONE_ACCOUNT, 'Synthetic second')),
    );
    expect(isWorkspaceOnePerAccountConflict(error)).toBe(true);
  });

  test('a second ARCHIVED project and a split-pending project are exempt from the index', async () => {
    await db.insert(projects).values(
      projectValues('00000000-0000-4000-a000-00000000d206', ONE_ACCOUNT, 'Synthetic archived 2', { status: 'archived' }),
    );
    await db.insert(projects).values(
      projectValues('00000000-0000-4000-a000-00000000d207', LEGACY_ACCOUNT, 'Synthetic legacy 3', { splitPending: true }),
    );
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.accountId, LEGACY_ACCOUNT));
    expect(count?.n).toBe(3);
  });

  test('projectCreationDenial: 409 workspace_has_project for an account with an active project', async () => {
    const denial = await projectCreationDenial(ONE_ACCOUNT);
    expect(denial?.status).toBe(409);
    expect(denial?.body).toMatchObject({ code: WORKSPACE_HAS_PROJECT_CODE, account_id: ONE_ACCOUNT, workspace_id: ONE_PROJECT });
    // A legacy account may not gain a further project either.
    expect((await projectCreationDenial(LEGACY_ACCOUNT))?.status).toBe(409);
    // An empty account is never refused with 409 (the plan cap may still apply: 403).
    expect((await projectCreationDenial(EMPTY_ACCOUNT))?.status).not.toBe(409);
  });

  test('projects_name_sync / accounts_name_sync mirror a 1:1 rename both ways', async () => {
    await db.update(projects).set({ name: 'Synthetic renamed project' }).where(eq(projects.projectId, ONE_PROJECT));
    expect(await accountName(ONE_ACCOUNT)).toBe('Synthetic renamed project');
    await db.update(accounts).set({ name: 'Synthetic renamed account' }).where(eq(accounts.accountId, ONE_ACCOUNT));
    expect(await projectName(ONE_PROJECT)).toBe('Synthetic renamed account');
    // The archived project keeps its own name.
    expect(await projectName(ARCHIVED_PROJECT)).toBe('Synthetic archived');
  });

  test('a legacy account and its projects keep independent names', async () => {
    await db.update(projects).set({ name: 'Synthetic legacy renamed' }).where(eq(projects.projectId, LEGACY_P1));
    expect(await accountName(LEGACY_ACCOUNT)).toBe('Synthetic legacy');
    await db.update(accounts).set({ name: 'Synthetic legacy account' }).where(eq(accounts.accountId, LEGACY_ACCOUNT));
    expect(await projectName(LEGACY_P2)).toBe('Synthetic legacy 2');
  });

  test('updateWorkspace writes the project and the account in one call', async () => {
    const updated = await updateWorkspace(asWorkspaceId(ONE_PROJECT), {
      name: 'Synthetic store rename',
      mfaRequired: true,
      sessionIdleTimeoutMinutes: 30,
      secretDefaultStrategy: 'broker',
    });
    expect(updated).toMatchObject({
      workspaceId: ONE_PROJECT,
      name: 'Synthetic store rename',
      mfaRequired: true,
      sessionIdleTimeoutMinutes: 30,
      secretDefaultStrategy: 'broker',
    });
    expect(await accountName(ONE_ACCOUNT)).toBe('Synthetic store rename');
    expect(await getWorkspace(ONE_PROJECT)).toMatchObject({ name: 'Synthetic store rename' });
  });

  test('updateWorkspace on a split-pending workspace renames only its project', async () => {
    await updateWorkspace(asWorkspaceId(LEGACY_P1), { name: 'Synthetic legacy store' });
    expect(await projectName(LEGACY_P1)).toBe('Synthetic legacy store');
    expect(await accountName(LEGACY_ACCOUNT)).toBe('Synthetic legacy');
  });

  test('updateWorkspace on an archived project is null and writes nothing', async () => {
    expect(await updateWorkspace(asWorkspaceId(ARCHIVED_PROJECT), { name: 'Synthetic nope' })).toBeNull();
    expect(await projectName(ARCHIVED_PROJECT)).toBe('Synthetic archived');
  });
});
