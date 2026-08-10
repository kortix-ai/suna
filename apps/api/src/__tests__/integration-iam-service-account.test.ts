/**
 * Integration test (real local DB): STANDING-IDENTITY service-account
 * authorization — the core of "agents run as agents". A service account has NO
 * membership baseline and NO built-in role; its ENTIRE authority is its own
 * iam_policies (principal_type='token'). This proves:
 *   - an activated SA is allowed exactly its policy's actions, scoped to scope
 *   - an SA with no policy is fail-closed (denied everything)
 *   - a disabled SA is denied everything
 *   - account-scoped vs project-scoped SA policies apply where they should
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accounts, iamPolicies, iamRoleActions, iamRoles, projects, serviceAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { authorizeV2 } from '../iam/engine-v2';
import { ACCOUNT_ACTIONS, WORKSPACE_ACTIONS } from '../iam';

const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const OTHER_WORKSPACE = crypto.randomUUID();
const uid = () => crypto.randomUUID();
const proj = (id: string) => ({ type: 'project' as const, id });

async function seedSA(status: 'active' | 'disabled' = 'active'): Promise<string> {
  const id = uid();
  await db.insert(serviceAccounts).values({
    serviceAccountId: id, accountId: ACCOUNT, name: `sa-${id.slice(0, 6)}`,
    secretHash: `h_${id}`, publicPrefix: `kortix_sa_${id.slice(0, 6)}`, status,
  });
  return id;
}
/** Create a custom role granting `actions` and bind it to `principalId` (a token/SA). */
async function bindRole(principalId: string, scopeType: 'account' | 'project', scopeId: string | null, actions: string[]) {
  const roleId = uid();
  await db.insert(iamRoles).values({ roleId, accountId: ACCOUNT, key: `r-${roleId.slice(0, 6)}`, name: 'r', scopeType });
  await db.insert(iamRoleActions).values(actions.map((action) => ({ roleId, action })));
  await db.insert(iamPolicies).values({ accountId: ACCOUNT, principalType: 'token', principalId, roleId, scopeType, scopeId });
}
const can = async (saId: string, action: string, target: { type: 'project'; id: string } | undefined) =>
  (await authorizeV2(saId, ACCOUNT, action, target)).allowed;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'sa-authz-test' });
  await db.insert(projects).values([
    { workspaceId: WORKSPACE, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' },
    { workspaceId: OTHER_WORKSPACE, accountId: ACCOUNT, name: 'o', repoUrl: 'https://example.com/o.git' },
  ]);
});
afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades SAs/roles/policies
});

describe('service-account authorization (standing identity)', () => {
  test('activated SA is allowed EXACTLY its policy actions, scoped to the policy scope', async () => {
    const sa = await seedSA();
    await bindRole(sa, 'project', WORKSPACE, [WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE]);

    expect(await can(sa, WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE, proj(WORKSPACE))).toBe(true); // granted
    expect(await can(sa, WORKSPACE_ACTIONS.WORKSPACE_WRITE, proj(WORKSPACE))).toBe(false); // no baseline → only the named action
    expect(await can(sa, WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE, proj(OTHER_WORKSPACE))).toBe(false); // scoped to WORKSPACE
  });

  test('an SA with NO policy is fail-closed (denied everything)', async () => {
    const sa = await seedSA();
    expect(await can(sa, WORKSPACE_ACTIONS.WORKSPACE_READ, proj(WORKSPACE))).toBe(false);
    expect((await authorizeV2(sa, ACCOUNT, WORKSPACE_ACTIONS.WORKSPACE_READ, proj(WORKSPACE))).reason).toBe(
      'service_account_scope_insufficient',
    );
  });

  test('a DISABLED SA is denied even with a policy', async () => {
    const sa = await seedSA('disabled');
    await bindRole(sa, 'project', WORKSPACE, [WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE]);
    expect(await can(sa, WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE, proj(WORKSPACE))).toBe(false);
    expect((await authorizeV2(sa, ACCOUNT, WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE, proj(WORKSPACE))).reason).toBe('not_a_member');
  });

  test('an account-scoped SA policy grants an account action (and reaches every project)', async () => {
    const sa = await seedSA();
    await bindRole(sa, 'account', null, [ACCOUNT_ACTIONS.MEMBER_READ, WORKSPACE_ACTIONS.WORKSPACE_READ]);
    // Account-scoped action allowed at account scope.
    expect((await authorizeV2(sa, ACCOUNT, ACCOUNT_ACTIONS.MEMBER_READ)).allowed).toBe(true);
    // An account-scoped policy also confers its project actions on EVERY project.
    expect(await can(sa, WORKSPACE_ACTIONS.WORKSPACE_READ, proj(WORKSPACE))).toBe(true);
    expect(await can(sa, WORKSPACE_ACTIONS.WORKSPACE_READ, proj(OTHER_WORKSPACE))).toBe(true);
  });
});
