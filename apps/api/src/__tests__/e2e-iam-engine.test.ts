/**
 * IAM engine integration tests against a real Postgres.
 *
 * Covers the SQL paths that the pure-function unit tests can't exercise:
 *   - super-admin short-circuit
 *   - account_role legacy bridge (owner/admin/member)
 *   - project_members legacy bridge
 *   - explicit policies on members and on groups (via membership)
 *   - allow + deny precedence
 *   - listAccessibleResources returning each of the four modes
 *   - token-as-principal: back-compat (no policies → inherit user) AND
 *     Cloudflare-style narrowing (any policy → token policies only)
 *
 * Set TEST_DATABASE_URL + KORTIX_TEST_DB_CONFIRM=I_UNDERSTAND_THIS_DELETES_TEST_DATA
 * to run. Otherwise the suite skips itself.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  accountTokens,
  accounts,
  iamPolicies,
  iamRoles,
  projects,
  projectMembers,
} from '@kortix/db';
import { getTestDb, HAS_SAFE_TEST_DB } from './helpers';
import { authorize, listAccessibleResources } from '../iam';
import { invalidateSystemRoleCache } from '../iam/engine';
import { seedSystemRoles, SYSTEM_ROLE_KEY } from '../iam/system-roles';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';

// Distinct UUID prefix (b000) keeps these fixtures from colliding with
// other integration suites (which use a000).
const ACC = '00000000-0000-4000-b000-000000000001';

const USER_SUPER         = '00000000-0000-4000-b000-000000000010';
const USER_OWNER         = '00000000-0000-4000-b000-000000000011';
const USER_ADMIN         = '00000000-0000-4000-b000-000000000012';
const USER_PLAIN_MEMBER  = '00000000-0000-4000-b000-000000000013';
const USER_POLICY_MEMBER = '00000000-0000-4000-b000-000000000014';
const USER_GROUP_MEMBER  = '00000000-0000-4000-b000-000000000015';
const USER_PROJECT_BRIDGE = '00000000-0000-4000-b000-000000000016';
const USER_DENY_MEMBER   = '00000000-0000-4000-b000-000000000017';

const PROJECT_A = '00000000-0000-4000-b000-000000000100';
const PROJECT_B = '00000000-0000-4000-b000-000000000101';
const PROJECT_C = '00000000-0000-4000-b000-000000000102';

const GROUP_EDITORS = '00000000-0000-4000-b000-000000000200';

const TOKEN_INHERIT = '00000000-0000-4000-b000-000000000300'; // no policies
const TOKEN_NARROW  = '00000000-0000-4000-b000-000000000301'; // viewer on A only

async function cleanup() {
  const db = getTestDb();
  // Tokens first (FK → accounts cascades, but be explicit so reruns are fast).
  await db.delete(accountTokens).where(inArray(accountTokens.tokenId, [TOKEN_INHERIT, TOKEN_NARROW]));
  // Deleting the account cascades to account_members, account_invitations,
  // account_groups (+ members), iam_roles (account-scoped) + iam_role_permissions,
  // iam_policies, projects (+ project_members), account_github_installations,
  // and account_tokens.
  await db.delete(accounts).where(eq(accounts.accountId, ACC));
}

/** Look up a system role by key (account_id IS NULL → built-in). */
async function findSystemRoleId(db: ReturnType<typeof getTestDb>, key: string): Promise<string> {
  const [row] = await db
    .select({ roleId: iamRoles.roleId })
    .from(iamRoles)
    .where(and(isNull(iamRoles.accountId), eq(iamRoles.key, key)))
    .limit(1);
  if (!row) {
    throw new Error(`system role "${key}" not found — seedSystemRoles() must run first`);
  }
  return row.roleId;
}

async function seed() {
  const db = getTestDb();

  // Account ─────────────────────────────────────────────────────────────────
  await db.insert(accounts).values({
    accountId: ACC,
    name: 'IAM Engine Test Account',
    personalAccount: false,
  });

  // Members ─────────────────────────────────────────────────────────────────
  await db.insert(accountMembers).values([
    { userId: USER_SUPER,          accountId: ACC, accountRole: 'owner',  isSuperAdmin: true  },
    { userId: USER_OWNER,          accountId: ACC, accountRole: 'owner',  isSuperAdmin: false },
    { userId: USER_ADMIN,          accountId: ACC, accountRole: 'admin',  isSuperAdmin: false },
    { userId: USER_PLAIN_MEMBER,   accountId: ACC, accountRole: 'member', isSuperAdmin: false },
    { userId: USER_POLICY_MEMBER,  accountId: ACC, accountRole: 'member', isSuperAdmin: false },
    { userId: USER_GROUP_MEMBER,   accountId: ACC, accountRole: 'member', isSuperAdmin: false },
    { userId: USER_PROJECT_BRIDGE, accountId: ACC, accountRole: 'member', isSuperAdmin: false },
    { userId: USER_DENY_MEMBER,    accountId: ACC, accountRole: 'member', isSuperAdmin: false },
  ]);

  // Projects ────────────────────────────────────────────────────────────────
  await db.insert(projects).values([
    {
      projectId: PROJECT_A, accountId: ACC, name: 'Project A',
      repoUrl: 'https://example.test/a.git',
    },
    {
      projectId: PROJECT_B, accountId: ACC, name: 'Project B',
      repoUrl: 'https://example.test/b.git',
    },
    {
      projectId: PROJECT_C, accountId: ACC, name: 'Project C',
      repoUrl: 'https://example.test/c.git',
    },
  ]);

  // Legacy project_members bridge for one specific user ─────────────────────
  await db.insert(projectMembers).values({
    accountId: ACC,
    projectId: PROJECT_A,
    userId: USER_PROJECT_BRIDGE,
    projectRole: 'editor',
  });

  // Group with one member, granted Project Editor on Project A ─────────────
  await db.insert(accountGroups).values({
    groupId: GROUP_EDITORS,
    accountId: ACC,
    name: 'Editors',
  });
  await db.insert(accountGroupMembers).values({
    groupId: GROUP_EDITORS,
    userId: USER_GROUP_MEMBER,
  });

  const projectViewerId = await findSystemRoleId(getTestDb(), SYSTEM_ROLE_KEY.PROJECT_VIEWER);
  const projectEditorId = await findSystemRoleId(getTestDb(), SYSTEM_ROLE_KEY.PROJECT_EDITOR);
  const administratorReadOnlyId = await findSystemRoleId(
    getTestDb(),
    SYSTEM_ROLE_KEY.ADMINISTRATOR_READ_ONLY,
  );

  // Policies ────────────────────────────────────────────────────────────────
  await db.insert(iamPolicies).values([
    // POLICY_MEMBER: explicit Project Viewer on Project A only
    {
      accountId: ACC,
      principalType: 'member',
      principalId: USER_POLICY_MEMBER,
      scopeType: 'project',
      scopeId: PROJECT_A,
      roleId: projectViewerId,
      effect: 'allow',
    },
    // GROUP_EDITORS group → Project Editor on Project A
    {
      accountId: ACC,
      principalType: 'group',
      principalId: GROUP_EDITORS,
      scopeType: 'project',
      scopeId: PROJECT_A,
      roleId: projectEditorId,
      effect: 'allow',
    },
    // DENY_MEMBER: allow Administrator Read-Only on Everything (so they
    // can read all projects via the role bundle), then deny Project Viewer
    // on Project B (so the read of B is stripped).
    {
      accountId: ACC,
      principalType: 'member',
      principalId: USER_DENY_MEMBER,
      scopeType: 'account',
      scopeId: null,
      roleId: administratorReadOnlyId,
      effect: 'allow',
    },
    {
      accountId: ACC,
      principalType: 'member',
      principalId: USER_DENY_MEMBER,
      scopeType: 'project',
      scopeId: PROJECT_B,
      roleId: projectViewerId,
      effect: 'deny',
    },
  ]);

  // PATs ────────────────────────────────────────────────────────────────────
  // Both minted by the super-admin so we can verify that narrowing strips
  // super-admin and back-compat preserves it.
  await db.insert(accountTokens).values([
    {
      tokenId: TOKEN_INHERIT,
      accountId: ACC,
      userId: USER_SUPER,
      name: 'inherit-test',
      publicKey: 'pk_test_inherit',
      secretKeyHash: 'hash_inherit',
      status: 'active',
    },
    {
      tokenId: TOKEN_NARROW,
      accountId: ACC,
      userId: USER_SUPER,
      name: 'narrow-test',
      publicKey: 'pk_test_narrow',
      secretKeyHash: 'hash_narrow',
      status: 'active',
    },
  ]);
  // Token policy: narrow PAT gets Project Viewer on Project A only.
  await db.insert(iamPolicies).values({
    accountId: ACC,
    principalType: 'token',
    principalId: TOKEN_NARROW,
    scopeType: 'project',
    scopeId: PROJECT_A,
    roleId: projectViewerId,
    effect: 'allow',
  });
}

describe.skipIf(!HAS_SAFE_TEST_DB)('IAM engine — real DB', () => {
  beforeAll(async () => {
    // Make sure system roles are present (they're idempotently seeded on
    // every API boot, but tests don't boot the server) AND invalidate the
    // in-memory cache so any prior test run's seed doesn't shadow ours.
    await seedSystemRoles();
    invalidateSystemRoleCache();
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ─── Super-admin ──────────────────────────────────────────────────────────

  test('super-admin bypass allows every action regardless of policies', async () => {
    for (const action of [
      ACCOUNT_ACTIONS.ACCOUNT_DELETE,
      ACCOUNT_ACTIONS.BILLING_WRITE,
      PROJECT_ACTIONS.PROJECT_DELETE,
    ]) {
      const r = await authorize(USER_SUPER, ACC, action);
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('super_admin');
    }
  });

  // ─── Legacy account_role bridges ─────────────────────────────────────────

  test('owner (not super-admin) bridges to Administrator: most account + all project', async () => {
    const r1 = await authorize(USER_OWNER, ACC, ACCOUNT_ACTIONS.MEMBER_INVITE);
    expect(r1.allowed).toBe(true);
    expect(r1.reason).toBe('legacy_account_role');

    const r2 = await authorize(USER_OWNER, ACC, PROJECT_ACTIONS.PROJECT_WRITE, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(r2.allowed).toBe(true);
  });

  test('owner (not super-admin) cannot delete account or grant super-admin via bridge', async () => {
    const r1 = await authorize(USER_OWNER, ACC, ACCOUNT_ACTIONS.ACCOUNT_DELETE);
    expect(r1.allowed).toBe(false);

    const r2 = await authorize(USER_OWNER, ACC, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);
    expect(r2.allowed).toBe(false);
  });

  test('admin gets the same Administrator bridge as owner', async () => {
    const r = await authorize(USER_ADMIN, ACC, ACCOUNT_ACTIONS.MEMBER_INVITE);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('legacy_account_role');
  });

  test('plain member gets account-level reads but no project access via bridge', async () => {
    const reads = [
      ACCOUNT_ACTIONS.ACCOUNT_READ,
      ACCOUNT_ACTIONS.MEMBER_READ,
      ACCOUNT_ACTIONS.GROUP_READ,
    ];
    for (const action of reads) {
      const r = await authorize(USER_PLAIN_MEMBER, ACC, action);
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('legacy_account_role');
    }

    // Crucially: no project reads via the tightened bridge.
    const r = await authorize(USER_PLAIN_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(r.allowed).toBe(false);
  });

  // ─── Explicit policies ───────────────────────────────────────────────────

  test('member with explicit Project Viewer on A sees A, not B', async () => {
    const onA = await authorize(USER_POLICY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(onA.allowed).toBe(true);
    expect(onA.reason).toBe('policy');

    const onB = await authorize(USER_POLICY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_B,
    });
    expect(onB.allowed).toBe(false);

    // Viewer doesn't grant writes either.
    const writeA = await authorize(USER_POLICY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_WRITE, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(writeA.allowed).toBe(false);
  });

  test('group inheritance: member of Editors group gets Project Editor on A', async () => {
    const r = await authorize(USER_GROUP_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_WRITE, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('policy');
  });

  // ─── project_members bridge ──────────────────────────────────────────────

  test('legacy project_members editor row bridges to project.read/write', async () => {
    const read = await authorize(USER_PROJECT_BRIDGE, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(read.allowed).toBe(true);
    expect(read.reason).toBe('legacy_project_role');

    const write = await authorize(USER_PROJECT_BRIDGE, ACC, PROJECT_ACTIONS.PROJECT_WRITE, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(write.allowed).toBe(true);

    // Editor doesn't include delete.
    const del = await authorize(USER_PROJECT_BRIDGE, ACC, PROJECT_ACTIONS.PROJECT_DELETE, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(del.allowed).toBe(false);

    // Bridge only applies to A; no access to B.
    const otherProj = await authorize(USER_PROJECT_BRIDGE, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_B,
    });
    expect(otherProj.allowed).toBe(false);
  });

  // ─── Allow + deny precedence ─────────────────────────────────────────────

  test('explicit deny wins over a broader allow', async () => {
    // DENY_MEMBER has Administrator Read-Only on Everything (reads
    // everything) plus a deny on Project Viewer for Project B.
    const onA = await authorize(USER_DENY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_A,
    });
    expect(onA.allowed).toBe(true);

    const onB = await authorize(USER_DENY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_B,
    });
    expect(onB.allowed).toBe(false);
    expect(onB.reason).toBe('explicit_deny');

    const onC = await authorize(USER_DENY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: PROJECT_C,
    });
    expect(onC.allowed).toBe(true);
  });

  // ─── listAccessibleResources modes ───────────────────────────────────────

  test('list mode: super-admin → all', async () => {
    const r = await listAccessibleResources(USER_SUPER, ACC, PROJECT_ACTIONS.PROJECT_READ, 'project');
    expect(r.mode).toBe('all');
  });

  test('list mode: owner via legacy admin bridge → all', async () => {
    const r = await listAccessibleResources(USER_OWNER, ACC, PROJECT_ACTIONS.PROJECT_READ, 'project');
    expect(r.mode).toBe('all');
  });

  test('list mode: plain member → allow_only with empty set (tightened bridge)', async () => {
    const r = await listAccessibleResources(USER_PLAIN_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, 'project');
    expect(r.mode).toBe('allow_only');
    if (r.mode === 'allow_only') {
      expect(r.allowed.size).toBe(0);
    }
  });

  test('list mode: explicit policy member → allow_only with that project', async () => {
    const r = await listAccessibleResources(USER_POLICY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, 'project');
    expect(r.mode).toBe('allow_only');
    if (r.mode === 'allow_only') {
      expect(r.allowed.has(PROJECT_A)).toBe(true);
      expect(r.allowed.has(PROJECT_B)).toBe(false);
    }
  });

  test('list mode: project_members user → allow_only via legacy bridge', async () => {
    const r = await listAccessibleResources(
      USER_PROJECT_BRIDGE, ACC, PROJECT_ACTIONS.PROJECT_READ, 'project',
    );
    expect(r.mode).toBe('allow_only');
    if (r.mode === 'allow_only') {
      expect(r.allowed.has(PROJECT_A)).toBe(true);
      expect(r.allowed.has(PROJECT_B)).toBe(false);
    }
  });

  test('list mode: allow Everything + deny on B → all_except {B}', async () => {
    const r = await listAccessibleResources(
      USER_DENY_MEMBER, ACC, PROJECT_ACTIONS.PROJECT_READ, 'project',
    );
    expect(r.mode).toBe('all_except');
    if (r.mode === 'all_except') {
      expect(r.denied.has(PROJECT_B)).toBe(true);
      expect(r.denied.has(PROJECT_A)).toBe(false);
    }
  });

  // ─── Token-as-principal ──────────────────────────────────────────────────

  test('token with NO policies falls back to user (back-compat)', async () => {
    const r = await authorize(
      USER_SUPER, ACC, PROJECT_ACTIONS.PROJECT_DELETE,
      { type: 'project', id: PROJECT_B },
      TOKEN_INHERIT,
    );
    expect(r.allowed).toBe(true);
    // Super-admin reason proves we fell through to user-based eval.
    expect(r.reason).toBe('super_admin');
  });

  test('token with narrow policy ignores minter super-admin', async () => {
    // The token's minter is a super-admin, but the narrow policy only
    // grants Project Viewer on Project A. So the token can:
    //   read Project A  → yes (token policy matches)
    //   write Project A → no (no token policy for write)
    //   read Project B  → no (no token policy for B)
    //   delete account  → no (no token policy at all for that)
    const readA = await authorize(
      USER_SUPER, ACC, PROJECT_ACTIONS.PROJECT_READ,
      { type: 'project', id: PROJECT_A },
      TOKEN_NARROW,
    );
    expect(readA.allowed).toBe(true);
    expect(readA.reason).toBe('token_policy');

    const writeA = await authorize(
      USER_SUPER, ACC, PROJECT_ACTIONS.PROJECT_WRITE,
      { type: 'project', id: PROJECT_A },
      TOKEN_NARROW,
    );
    expect(writeA.allowed).toBe(false);
    expect(writeA.reason).toBe('token_no_matching_policy');

    const readB = await authorize(
      USER_SUPER, ACC, PROJECT_ACTIONS.PROJECT_READ,
      { type: 'project', id: PROJECT_B },
      TOKEN_NARROW,
    );
    expect(readB.allowed).toBe(false);

    const deleteAccount = await authorize(
      USER_SUPER, ACC, ACCOUNT_ACTIONS.ACCOUNT_DELETE,
      undefined,
      TOKEN_NARROW,
    );
    expect(deleteAccount.allowed).toBe(false);
  });

  test('list mode under narrow token returns only the scoped resource', async () => {
    const r = await listAccessibleResources(
      USER_SUPER, ACC, PROJECT_ACTIONS.PROJECT_READ, 'project', TOKEN_NARROW,
    );
    expect(r.mode).toBe('allow_only');
    if (r.mode === 'allow_only') {
      expect(r.allowed.size).toBe(1);
      expect(r.allowed.has(PROJECT_A)).toBe(true);
    }
  });

  // ─── Negative case: non-member ───────────────────────────────────────────

  test('user with no account_members row is denied with not_a_member reason', async () => {
    const ghostUserId = '00000000-0000-4000-b000-000000000999';
    const r = await authorize(ghostUserId, ACC, ACCOUNT_ACTIONS.ACCOUNT_READ);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_a_member');
  });
});
