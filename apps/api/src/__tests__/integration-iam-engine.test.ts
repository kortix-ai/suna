/**
 * Integration test (real local DB) for the authorization ENGINE (authorizeV2).
 *
 * Proves the model an enterprise (acme-inc) relies on, end to end against a
 * fully ISOLATED account + project seeded here and torn down after:
 *   - deny-by-default (a plain member with no grant is denied)
 *   - built-in project roles (member ⊂ editor ⊂ manager)
 *   - account owner/admin are implicit Managers on every project
 *   - group → project role (the SCIM/SSO bulk-access channel), incl. max-rank
 *   - DB custom role → policy binding → enforcement, scoped to one project
 *   - revoke immediacy (mutation + cache invalidation → next check denies)
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  accounts,
  iamPolicies,
  iamRoleActions,
  iamRoles,
  projectGroupGrants,
  projectMembers,
  projects,
} from '@kortix/db';
import { db } from '../shared/db';
import { authorizeV2 } from '../iam/engine-v2';
import { PROJECT_ACTIONS } from '../iam';
import { invalidateIamCacheForUser } from '../iam/cache-invalidation';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const uid = () => crypto.randomUUID();

const proj = (id: string) => ({ type: 'project' as const, id });
const allow = async (userId: string, action: string, target: { type: 'project'; id: string }) =>
  (await authorizeV2(userId, ACCOUNT, action, target)).allowed;

async function seedMember(role: 'owner' | 'admin' | 'member'): Promise<string> {
  const userId = uid();
  await db.insert(accountMembers).values({ userId, accountId: ACCOUNT, accountRole: role });
  return userId;
}
async function grantProject(userId: string, role: 'member' | 'editor' | 'manager') {
  await db.insert(projectMembers).values({ accountId: ACCOUNT, projectId: PROJECT, userId, projectRole: role });
}
async function seedGroup(name: string): Promise<string> {
  const groupId = uid();
  await db.insert(accountGroups).values({ groupId, accountId: ACCOUNT, name });
  return groupId;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'iam-engine-test' });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' },
    { projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'other', repoUrl: 'https://example.com/o.git' },
  ]);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades members/groups/roles/policies
});

describe('authorizeV2 — deny-by-default + built-in project roles', () => {
  test('a plain account member with NO project grant is denied everything on the project', async () => {
    const u = await seedMember('member');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_READ, proj(PROJECT))).toBe(false);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(false);
    expect((await authorizeV2(u, ACCOUNT, PROJECT_ACTIONS.PROJECT_READ, proj(PROJECT))).reason).toBe(
      'no_project_membership',
    );
  });

  test("project role 'member' can read + run sessions but not write or manage", async () => {
    const u = await seedMember('member');
    await grantProject(u, 'member');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_READ, proj(PROJECT))).toBe(true);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_SESSION_START, proj(PROJECT))).toBe(true);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(false);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, proj(PROJECT))).toBe(false);
  });

  test("'editor' adds write + deploy but not member management", async () => {
    const u = await seedMember('member');
    await grantProject(u, 'editor');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(true);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(PROJECT))).toBe(true);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, proj(PROJECT))).toBe(false);
  });

  test("'manager' can manage members", async () => {
    const u = await seedMember('member');
    await grantProject(u, 'manager');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, proj(PROJECT))).toBe(true);
  });

  test('a grant on THIS project does not leak to another project', async () => {
    const u = await seedMember('member');
    await grantProject(u, 'editor');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(true);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(OTHER_PROJECT))).toBe(false);
  });
});

describe('authorizeV2 — account owner/admin are implicit Managers', () => {
  test('account owner manages any project with no explicit grant', async () => {
    const u = await seedMember('owner');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, proj(PROJECT))).toBe(true);
  });
  test('account admin likewise', async () => {
    const u = await seedMember('admin');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, proj(OTHER_PROJECT))).toBe(true);
  });
});

describe('authorizeV2 — group → project role (the SCIM/SSO bulk channel)', () => {
  test('membership in a group granted a project role confers that role', async () => {
    const u = await seedMember('member');
    const g = await seedGroup(`eng-${uid().slice(0, 6)}`);
    await db.insert(accountGroupMembers).values({ groupId: g, userId: u });
    await db.insert(projectGroupGrants).values({ projectId: PROJECT, groupId: g, accountId: ACCOUNT, role: 'editor' });
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(true);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, proj(PROJECT))).toBe(false);
  });

  test('two group grants → the HIGHER role wins (max-rank)', async () => {
    const u = await seedMember('member');
    const gLow = await seedGroup(`low-${uid().slice(0, 6)}`);
    const gHigh = await seedGroup(`high-${uid().slice(0, 6)}`);
    await db.insert(accountGroupMembers).values([
      { groupId: gLow, userId: u },
      { groupId: gHigh, userId: u },
    ]);
    await db.insert(projectGroupGrants).values([
      { projectId: PROJECT, groupId: gLow, accountId: ACCOUNT, role: 'member' },
      { projectId: PROJECT, groupId: gHigh, accountId: ACCOUNT, role: 'manager' },
    ]);
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, proj(PROJECT))).toBe(true);
  });
});

describe('authorizeV2 — DB custom role → policy binding (allow-only union)', () => {
  test('a project-scoped custom role grants an extra action on ONE project only', async () => {
    const u = await seedMember('member');
    await grantProject(u, 'member'); // baseline: cannot create triggers
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(PROJECT))).toBe(false);

    // Custom role that grants trigger creation, bound to this member for THIS project.
    const roleId = uid();
    await db.insert(iamRoles).values({ roleId, accountId: ACCOUNT, key: `scheduler-${uid().slice(0, 6)}`, name: 'Scheduler', scopeType: 'project' });
    await db.insert(iamRoleActions).values({ roleId, action: PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE });
    await db.insert(iamPolicies).values({
      accountId: ACCOUNT, principalType: 'member', principalId: u, roleId, scopeType: 'project', scopeId: PROJECT,
    });
    invalidateIamCacheForUser(u);

    expect(await allow(u, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(PROJECT))).toBe(true);
    // Scoped to PROJECT — the policy does not apply to OTHER_PROJECT.
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(OTHER_PROJECT))).toBe(false);
  });
});

describe('authorizeV2 — revoke immediacy (cache invalidation)', () => {
  test('removing a project grant + invalidating denies on the very next check', async () => {
    const u = await seedMember('member');
    await grantProject(u, 'editor');
    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(true); // caches the actor+role

    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, PROJECT), eq(projectMembers.userId, u)));
    invalidateIamCacheForUser(u); // what the real mutation routes call

    expect(await allow(u, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(false);
  });
});
