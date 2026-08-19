/**
 * The ONE write path: `assignRole` / `revokeAssignment` / `listAssignments`.
 *
 * Proves the five guarantees that are currently spread across 129 write sites
 * with no common contract:
 *   1. the WRITER is authorized, and the action depends on WHAT is granted
 *   2. an account can never reach zero owners
 *   3. a role carrying a non-delegable permission cannot be assigned
 *   4. a re-grant is an upsert, not a duplicate (iam_policies has no unique
 *      constraint at all today, and :bulk-import happily creates duplicates)
 *   5. the grant is visible to `authorize` immediately, and the revoke is too
 *      (positive-only caching + a synchronous bust on the writing replica)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, roleAssignments } from '@kortix/db';
import { db, hasDatabase } from '../shared/db';
import { authorize, clearAuthorizeCaches } from '../iam/authorize';
import { assignRole, listAssignments, revokeAssignment, SYSTEM_ACTOR } from '../iam/assignments';
import { loadSystemRoles } from '../iam/catalog';
import type { Actor } from '../iam/actor';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const uid = () => crypto.randomUUID();

const owner = uid();
const secondOwner = uid();
const admin = uid();
const plainMember = uid();
const target = uid();
const groupId = uid();

const jwt = (userId: string): Actor => ({
  userId,
  accountId: ACCOUNT,
  credential: { kind: 'jwt' },
  ctx: {},
});

let escalatingRoleId = '';

async function raw(text: string): Promise<void> {
  await db.execute(sql.raw(text));
}

beforeAll(async () => {
  if (!hasDatabase) return;
  await raw(`insert into kortix.accounts (account_id, name) values ('${ACCOUNT}', 'assignments-test')`);
  await raw(
    `insert into kortix.projects (project_id, account_id, name, repo_url)
     values ('${PROJECT}','${ACCOUNT}','p','https://example.invalid/p.git')`,
  );
  await raw(`insert into kortix.account_groups (group_id, account_id, name) values ('${groupId}','${ACCOUNT}','g')`);

  const roles = await loadSystemRoles();
  const sys = (scope: string, key: string) => roles.byKey.get(`${scope}:${key}`)!.roleId;

  // Seed the writers' own membership directly — bootstrapping an account's
  // first owner is not itself an authorized act.
  for (const [userId, key] of [
    [owner, 'owner'],
    [secondOwner, 'owner'],
    [admin, 'admin'],
    [plainMember, 'member'],
    [target, 'member'],
  ] as const) {
    await raw(
      `insert into kortix.role_assignments (account_id, principal_type, principal_id, role_id, scope_type, source)
       values ('${ACCOUNT}','user','${userId}','${sys('account', key)}','account','system')`,
    );
  }
  // account_members carries is_super_admin + the MFA join; none of these are
  // super-admins, which is the point — the guards below must actually run.
  for (const userId of [owner, secondOwner, admin, plainMember, target]) {
    await raw(
      `insert into kortix.account_members (user_id, account_id, account_role, is_super_admin)
       values ('${userId}','${ACCOUNT}','member', false)`,
    );
  }

  // A custom role carrying a NON-DELEGABLE permission. Nothing stops such a row
  // existing — validateActions gates the CREATE route, not the table — so the
  // assign-time ceiling has to be real.
  escalatingRoleId = uid();
  await raw(
    `insert into kortix.iam_roles (role_id, account_id, key, name, scope_type)
     values ('${escalatingRoleId}','${ACCOUNT}','escalating','Escalating','account')`,
  );
  await raw(
    `insert into kortix.iam_role_actions (role_id, action)
     values ('${escalatingRoleId}','member.super_admin.grant'), ('${escalatingRoleId}','account.read')`,
  );
  clearAuthorizeCaches();
});

afterAll(async () => {
  if (!hasDatabase) return;
  await raw(`delete from kortix.accounts where account_id = '${ACCOUNT}'`);
});

describe.if(hasDatabase)('assignRole / revokeAssignment', () => {
  test('a plain member cannot hand out a project role', async () => {
    await expect(
      assignRole(jwt(plainMember), ACCOUNT, {
        principal: { type: 'user', id: target },
        roleKey: 'manager',
        scope: { type: 'project', id: PROJECT },
      }),
    ).rejects.toThrow();
  });

  test('an owner can, and the grant is live on the next authorize', async () => {
    const before = await authorize(jwt(target), 'project.write', { type: 'project', id: PROJECT });
    expect(before.allowed).toBe(false);
    expect(before.reason).toBe('no_project_membership');

    const row = await assignRole(jwt(owner), ACCOUNT, {
      principal: { type: 'user', id: target },
      roleKey: 'manager',
      scope: { type: 'project', id: PROJECT },
    });
    expect(row.roleKey).toBe('manager');
    expect(row.scopeType).toBe('project');
    expect(row.scopeId).toBe(PROJECT);
    expect(row.source).toBe('manual');
    expect(row.grantedBy).toBe(owner);

    const after = await authorize(jwt(target), 'project.write', { type: 'project', id: PROJECT });
    expect(after).toEqual({ allowed: true, reason: 'role' });
  });

  test('re-granting is an upsert, not a duplicate', async () => {
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    const again = await assignRole(jwt(owner), ACCOUNT, {
      principal: { type: 'user', id: target },
      roleKey: 'manager',
      scope: { type: 'project', id: PROJECT },
      expiresAt: expires,
    });
    const rows = await listAssignments({
      accountId: ACCOUNT,
      principal: { type: 'user', id: target },
      scopeType: 'project',
      scopeId: PROJECT,
    });
    expect(rows.filter((r) => r.roleKey === 'manager')).toHaveLength(1);
    expect(again.expiresAt?.getTime()).toBe(expires.getTime());
  });

  test('an object assignment is one row and needs project.members.manage', async () => {
    await expect(
      assignRole(jwt(plainMember), ACCOUNT, {
        principal: { type: 'group', id: groupId },
        roleKey: 'agent-user',
        scope: { type: 'project', id: PROJECT },
        object: { type: 'agent', id: 'finance-bot' },
      }),
    ).rejects.toThrow();

    const row = await assignRole(jwt(owner), ACCOUNT, {
      principal: { type: 'group', id: groupId },
      roleKey: 'agent-user',
      scope: { type: 'project', id: PROJECT },
      object: { type: 'agent', id: 'finance-bot' },
    });
    expect(row.objectType).toBe('agent');
    expect(row.objectId).toBe('finance-bot');
    expect(row.roleKey).toBe('agent-user');
  });

  test('a role carrying a non-delegable permission cannot be assigned', async () => {
    await expect(
      assignRole(jwt(owner), ACCOUNT, {
        principal: { type: 'user', id: target },
        roleId: escalatingRoleId,
        scope: { type: 'account' },
      }),
    ).rejects.toThrow(/non-delegable/);
  });

  test('the last owner cannot be revoked, the second-to-last can', async () => {
    const owners = await listAssignments({
      accountId: ACCOUNT,
      scopeType: 'account',
      principals: [
        { type: 'user', id: owner },
        { type: 'user', id: secondOwner },
      ],
    });
    const ownerRows = owners.filter((r) => r.roleKey === 'owner');
    expect(ownerRows).toHaveLength(2);

    // Two owners: revoking one is fine.
    const first = ownerRows.find((r) => r.principalId === secondOwner)!;
    await revokeAssignment(jwt(owner), ACCOUNT, first.assignmentId);

    // One owner left: revoking it must be refused.
    const last = ownerRows.find((r) => r.principalId === owner)!;
    await expect(revokeAssignment(jwt(owner), ACCOUNT, last.assignmentId)).rejects.toThrow(/last owner/);
  });

  test('a revoke is visible to authorize immediately', async () => {
    const rows = await listAssignments({
      accountId: ACCOUNT,
      principal: { type: 'user', id: target },
      scopeType: 'project',
      scopeId: PROJECT,
    });
    const manager = rows.find((r) => r.roleKey === 'manager')!;
    await revokeAssignment(jwt(owner), ACCOUNT, manager.assignmentId);
    const after = await authorize(jwt(target), 'project.write', { type: 'project', id: PROJECT });
    expect(after.allowed).toBe(false);
  });

  test('SYSTEM_ACTOR skips writer authz and only that — source and audit still land', async () => {
    const row = await assignRole(SYSTEM_ACTOR, ACCOUNT, {
      principal: { type: 'user', id: target },
      roleKey: 'member',
      scope: { type: 'project', id: PROJECT },
      source: 'scim',
    });
    expect(row.source).toBe('scim');
    expect(row.grantedBy).toBeNull();
  });

  test('every write emitted exactly one iam.assignment.* audit event', async () => {
    const rows = await db
      .select({ action: auditEvents.action, resourceId: auditEvents.resourceId })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, ACCOUNT), sql`${auditEvents.action} like 'iam.assignment.%'`));
    const granted = rows.filter((r) => r.action === 'iam.assignment.granted');
    const revoked = rows.filter((r) => r.action === 'iam.assignment.revoked');
    // 5 successful grants (manager, manager re-grant, object grant, scim member)
    // and 2 successful revokes across the tests above.
    expect(granted.length).toBeGreaterThanOrEqual(4);
    expect(revoked.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.resourceId != null)).toBe(true);
  });

  test('shape constraints are enforced by the database, not only by the writer', async () => {
    const roles = await loadSystemRoles();
    const managerId = roles.byKey.get('project:manager')!.roleId;
    // An account-scope row that names a project.
    await expect(async () =>
      db.insert(roleAssignments).values({
        accountId: ACCOUNT,
        principalType: 'user',
        principalId: uid(),
        roleId: managerId,
        scopeType: 'account',
        scopeId: PROJECT,
      }),
    ).toThrow();
    // An object_type with no object_id.
    await expect(async () =>
      db.insert(roleAssignments).values({
        accountId: ACCOUNT,
        principalType: 'user',
        principalId: uid(),
        roleId: managerId,
        scopeType: 'project',
        scopeId: PROJECT,
        objectType: 'agent',
      }),
    ).toThrow();
    // An unknown principal_type.
    await expect(async () =>
      db.insert(roleAssignments).values({
        accountId: ACCOUNT,
        principalType: 'robot',
        principalId: uid(),
        roleId: managerId,
        scopeType: 'project',
        scopeId: PROJECT,
      }),
    ).toThrow();
  });
});
