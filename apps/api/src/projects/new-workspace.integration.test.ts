/**
 * DB suite: which account `new_workspace: true` provisions into
 * (projects/new-workspace.ts): always a new one, except an idempotent replay
 * (review findings 1 and 9). Real schema, real role store; nothing mocked.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { accountDeletionRequests, accountMembers, accounts, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { insertIntoView } from '../__tests__/helpers/compat-views';
import { config } from '../config';
import { accountRoleFor } from '../iam/read-models';
import { db } from '../shared/db';
import { resolveNewWorkspaceAccount, type NewWorkspaceCaller } from './new-workspace';

const created: string[] = [];
const users: string[] = [];

async function person(): Promise<NewWorkspaceCaller> {
  const userId = crypto.randomUUID();
  users.push(userId);
  await db.execute(sql`insert into auth.users (id, email) values (${userId}::uuid, ${`nw-${userId}@example.test`})`);
  return { userId, email: null, authType: 'supabase', scopedCredential: false };
}

async function account(userId: string, role: 'owner' | 'member', opts: { createdAt?: string; projects?: number; key?: string } = {}) {
  const accountId = crypto.randomUUID();
  created.push(accountId);
  await db.insert(accounts).values({
    accountId,
    name: `nw-${role}`,
    ...(opts.createdAt ? { createdAt: new Date(opts.createdAt) } : {}),
  });
  await insertIntoView(db, accountMembers, [{ accountId, userId, accountRole: role }]);
  for (let i = 0; i < (opts.projects ?? 0); i++) {
    await db.insert(projects).values({
      projectId: crypto.randomUUID(),
      accountId,
      name: `nw-p${i}`,
      repoUrl: `https://example.invalid/${accountId}-${i}.git`,
      // 2+ projects = a legacy multi-project account (Workspaces split_pending).
      splitPending: (opts.projects ?? 0) > 1,
      ...(opts.key && i === 0 ? { idempotencyKey: opts.key } : {}),
    });
  }
  return accountId;
}

async function resolve(caller: NewWorkspaceCaller, key: string | null = null) {
  const result = await resolveNewWorkspaceAccount(caller, 'Acme Workspace', key);
  if (result.ok && result.created) created.push(result.accountId);
  return result;
}

afterAll(async () => {
  await db.delete(projects).where(inArray(projects.accountId, created));
  await db.delete(accountDeletionRequests).where(inArray(accountDeletionRequests.accountId, created));
  await db.delete(accounts).where(inArray(accounts.accountId, created));
  if (users.length) await db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)})`);
});

describe('new_workspace account choice', () => {
  test('a person with no account gets a new account they own, named after the project', async () => {
    const caller = await person();
    const result = await resolve(caller);
    expect(result).toMatchObject({ ok: true, created: true });
    if (!result.ok) return;
    const [row] = await db.select().from(accounts).where(eq(accounts.accountId, result.accountId));
    expect(row?.name).toBe('Acme Workspace');
    expect(await accountRoleFor(result.accountId, caller.userId)).toBe('owner');
  });

  test('an owned account with no project is never reused: a new account is created', async () => {
    const caller = await person();
    const empty = await account(caller.userId, 'owner', { createdAt: '2026-06-01T00:00:00Z' });
    const result = await resolve(caller);
    expect(result).toMatchObject({ ok: true, created: true });
    if (result.ok) expect(result.accountId).not.toBe(empty);
  });

  test('an account holding only an archived project (a deleted workspace) is not reused, with or without a key', async () => {
    const caller = await person();
    const deleted = await account(caller.userId, 'owner');
    await db.insert(projects).values({
      projectId: crypto.randomUUID(),
      accountId: deleted,
      name: 'nw-deleted',
      repoUrl: `https://example.invalid/${deleted}.git`,
      status: 'archived',
    });
    for (const key of [null, 'nw-archived-key']) {
      // (With a key, the virgin account the first iteration just made is an
      // in-flight replay and may be returned: never the deleted one.)
      const result = await resolve(caller, key);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.accountId).not.toBe(deleted);
    }
  });

  test('an account with a second member is not reused, with or without a key', async () => {
    const caller = await person();
    const other = await person();
    const shared = await account(caller.userId, 'owner');
    await insertIntoView(db, accountMembers, [{ accountId: shared, userId: other.userId, accountRole: 'member' }]);
    for (const key of [null, 'nw-shared-key']) {
      // (With a key, the virgin account the first iteration just made is an
      // in-flight replay and may be returned: never the shared one.)
      const result = await resolve(caller, key);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.accountId).not.toBe(shared);
    }
  });

  test('an owned account with a project, or one the person only belongs to, is not reused', async () => {
    const caller = await person();
    const busy = await account(caller.userId, 'owner', { projects: 1 });
    const joined = await account(caller.userId, 'member');
    const result = await resolve(caller);
    expect(result).toMatchObject({ ok: true, created: true });
    if (result.ok) expect([busy, joined]).not.toContain(result.accountId);
  });

  test('an empty account with a pending deletion is not reused', async () => {
    const caller = await person();
    const doomed = await account(caller.userId, 'owner');
    await db.insert(accountDeletionRequests).values({
      accountId: doomed,
      userId: caller.userId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'pending',
    });
    const result = await resolve(caller);
    expect(result).toMatchObject({ ok: true, created: true });
  });

  test('a retry of the same idempotency key returns the account its project lives in', async () => {
    const caller = await person();
    const keyed = await account(caller.userId, 'owner', { projects: 1, key: 'nw-retry-key' });
    await account(caller.userId, 'owner', { createdAt: '2027-01-01T00:00:00Z' });
    expect(await resolve(caller, 'nw-retry-key')).toEqual({ ok: true, accountId: keyed, created: false });
  });

  test('two concurrent attempts with one key choose one account', async () => {
    const caller = await person();
    const [a, b] = await Promise.all([resolve(caller, 'nw-race-key'), resolve(caller, 'nw-race-key')]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.accountId).toBe(b.accountId);
  });

  test('restricted account creation refuses a new account, even when the person owns an empty one', async () => {
    const mutable = config as { KORTIX_RESTRICT_ACCOUNT_CREATION: boolean };
    const before = mutable.KORTIX_RESTRICT_ACCOUNT_CREATION;
    mutable.KORTIX_RESTRICT_ACCOUNT_CREATION = true;
    try {
      const caller = await person();
      expect(await resolve(caller)).toMatchObject({
        ok: false,
        result: { status: 403, body: { code: 'account_creation_restricted' } },
      });
      await account(caller.userId, 'owner', { createdAt: '2026-01-01T00:00:00Z' });
      expect(await resolve(caller)).toMatchObject({
        ok: false,
        result: { status: 403, body: { code: 'account_creation_restricted' } },
      });
    } finally {
      mutable.KORTIX_RESTRICT_ACCOUNT_CREATION = before;
    }
  });

  test('only a person creates a workspace', async () => {
    const caller = await person();
    for (const who of [
      { ...caller, authType: 'apiKey' },
      { ...caller, authType: 'service_account' },
      { ...caller, authType: 'pat', scopedCredential: true },
    ]) {
      expect(await resolve(who)).toMatchObject({
        ok: false,
        result: { status: 403, body: { code: 'new_workspace_requires_person' } },
      });
    }
  });
});

describe('workspace name = account name = project name', () => {
  test("renaming an account's only project renames the account; with two projects it does not", async () => {
    const { renameAccountOfSoleProject } = await import('./lib/workspace-name');
    const caller = await person();
    const sole = await account(caller.userId, 'owner', { projects: 1 });
    const [soleProject] = await db.select().from(projects).where(eq(projects.accountId, sole));
    await renameAccountOfSoleProject(soleProject!, 'Renamed Workspace');
    expect((await db.select().from(accounts).where(eq(accounts.accountId, sole)))[0]?.name).toBe('Renamed Workspace');

    const legacy = await account(caller.userId, 'owner', { projects: 2 });
    const [first] = await db.select().from(projects).where(eq(projects.accountId, legacy));
    await renameAccountOfSoleProject(first!, 'Not The Account');
    expect((await db.select().from(accounts).where(eq(accounts.accountId, legacy)))[0]?.name).toBe('nw-owner');
  });
});

describe('self-host platform admin without a personal account', () => {
  test('an allowlisted email is a platform admin whatever its accounts are, and creates a workspace under the restriction', async () => {
    const { isPlatformAdmin } = await import('../shared/platform-roles');
    const caller = await person();
    const email = `nw-admin-${caller.userId}@example.test`;
    await db.execute(sql`update auth.users set email = ${email} where id = ${caller.userId}::uuid`);
    const mutable = config as { KORTIX_RESTRICT_ACCOUNT_CREATION: boolean };
    const before = { restrict: mutable.KORTIX_RESTRICT_ACCOUNT_CREATION, admins: process.env.KORTIX_PLATFORM_ADMIN_EMAILS };
    mutable.KORTIX_RESTRICT_ACCOUNT_CREATION = true;
    process.env.KORTIX_PLATFORM_ADMIN_EMAILS = `someone@example.test, ${email.toUpperCase()}`;
    try {
      // The admin's only account has its own id, never the user id.
      const owned = await account(caller.userId, 'owner', { projects: 1 });
      expect(owned).not.toBe(caller.userId);
      expect(await isPlatformAdmin(caller.userId)).toBe(true);
      const result = await resolve(caller);
      expect(result).toMatchObject({ ok: true, created: true });
      if (result.ok) expect(result.accountId).not.toBe(caller.userId);

      // Control: a person not on the list is refused.
      const other = await person();
      expect(await isPlatformAdmin(other.userId)).toBe(false);
      expect(await resolve(other)).toMatchObject({ ok: false, result: { status: 403, body: { code: 'account_creation_restricted' } } });
    } finally {
      mutable.KORTIX_RESTRICT_ACCOUNT_CREATION = before.restrict;
      if (before.admins === undefined) delete process.env.KORTIX_PLATFORM_ADMIN_EMAILS;
      else process.env.KORTIX_PLATFORM_ADMIN_EMAILS = before.admins;
    }
  });
});
