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
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
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
    { projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' },
    { projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'o', repoUrl: 'https://example.com/o.git' },
  ]);
});
afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades SAs/roles/policies
});

describe('service-account authorization (standing identity)', () => {
  test('activated SA is allowed EXACTLY its policy actions, scoped to the policy scope', async () => {
    const sa = await seedSA();
    await bindRole(sa, 'project', PROJECT, [PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE]);

    expect(await can(sa, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(PROJECT))).toBe(true); // granted
    expect(await can(sa, PROJECT_ACTIONS.PROJECT_WRITE, proj(PROJECT))).toBe(false); // no baseline → only the named action
    expect(await can(sa, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(OTHER_PROJECT))).toBe(false); // scoped to PROJECT
  });

  test('an SA with NO policy is fail-closed (denied everything)', async () => {
    const sa = await seedSA();
    expect(await can(sa, PROJECT_ACTIONS.PROJECT_READ, proj(PROJECT))).toBe(false);
    expect((await authorizeV2(sa, ACCOUNT, PROJECT_ACTIONS.PROJECT_READ, proj(PROJECT))).reason).toBe(
      'service_account_scope_insufficient',
    );
  });

  test('a DISABLED SA is denied even with a policy', async () => {
    const sa = await seedSA('disabled');
    await bindRole(sa, 'project', PROJECT, [PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE]);
    expect(await can(sa, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(PROJECT))).toBe(false);
    expect((await authorizeV2(sa, ACCOUNT, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, proj(PROJECT))).reason).toBe('not_a_member');
  });

  test('an account-scoped SA policy grants an account action (and reaches every project)', async () => {
    const sa = await seedSA();
    await bindRole(sa, 'account', null, [ACCOUNT_ACTIONS.MEMBER_READ, PROJECT_ACTIONS.PROJECT_READ]);
    // Account-scoped action allowed at account scope.
    expect((await authorizeV2(sa, ACCOUNT, ACCOUNT_ACTIONS.MEMBER_READ)).allowed).toBe(true);
    // An account-scoped policy also confers its project actions on EVERY project.
    expect(await can(sa, PROJECT_ACTIONS.PROJECT_READ, proj(PROJECT))).toBe(true);
    expect(await can(sa, PROJECT_ACTIONS.PROJECT_READ, proj(OTHER_PROJECT))).toBe(true);
  });
});
