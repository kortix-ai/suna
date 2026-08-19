/**
 * The SEED is the code, byte for byte.
 *
 * `kortix.permissions` + the 6 seeded system roles replace three hand-maintained
 * code constants — `ACCOUNT_ROLE_PERMS` / `PROJECT_ROLE_PERMS`
 * (iam/role-perms.ts), the action catalog (iam/actions.ts) and
 * `NON_DELEGABLE_ACTIONS` (accounts/iam/role-presets.ts). Until the cutover both
 * exist, and a seed that silently drifts from the Sets is a permission change
 * nobody reviewed. This test pins them equal, in both directions.
 *
 * It also pins the two catalog DECISIONS from spec §2.4, so re-adding either by
 * accident fails here rather than in production:
 *   * project.cr.open / project.cr.merge are GONE (collapsed into the gitops
 *     leaves they were already aliased to)
 *   * trigger.* is GONE (cataloged, in no role, asserted by no route)
 */
import { describe, expect, test } from 'bun:test';
import { eq, isNull, sql } from 'drizzle-orm';
import { iamRoleActions, iamRoles, objectPolicies, permissions } from '@kortix/db';
import { db, hasDatabase } from '../shared/db';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';
import { ACCOUNT_ROLE_PERMS, PROJECT_ROLE_PERMS } from '../iam/role-perms';
import { NON_DELEGABLE_ACTIONS } from '../accounts/iam/role-presets';
import { pendingPrincipalId } from '../iam/actor';

const COLLAPSED: Record<string, string> = {
  'project.cr.open': 'project.gitops.push',
  'project.cr.merge': 'project.gitops.merge',
};

/** The code Set, with the two collapsed aliases mapped, sorted. */
function expected(set: ReadonlySet<string>): string[] {
  return [...new Set([...set].map((a) => COLLAPSED[a] ?? a))].sort();
}

async function systemRoleActions(key: string, scopeType: string): Promise<string[]> {
  const rows = await db
    .select({ action: iamRoleActions.action })
    .from(iamRoleActions)
    .innerJoin(iamRoles, eq(iamRoles.roleId, iamRoleActions.roleId))
    .where(isNull(iamRoles.accountId));
  const roleRows = await db
    .select({ roleId: iamRoles.roleId, key: iamRoles.key, scopeType: iamRoles.scopeType })
    .from(iamRoles)
    .where(isNull(iamRoles.accountId));
  const role = roleRows.find((r) => r.key === key && r.scopeType === scopeType);
  if (!role) return [];
  const scoped = await db
    .select({ action: iamRoleActions.action })
    .from(iamRoleActions)
    .where(eq(iamRoleActions.roleId, role.roleId));
  void rows;
  return scoped.map((r) => r.action).sort();
}

describe.if(hasDatabase)('canonical RBAC seed == the code it replaces', () => {
  test('the catalog is exactly the live action strings, minus the two spec §2.4 decisions', async () => {
    const rows = await db.select({ action: permissions.action, scopeType: permissions.scopeType }).from(permissions);
    const seeded = rows.map((r) => r.action).sort();

    const fromCode = [
      ...Object.values(ACCOUNT_ACTIONS),
      ...Object.values(PROJECT_ACTIONS),
    ]
      .filter((a) => !(a in COLLAPSED))
      .sort();

    expect(seeded).toEqual(fromCode);
    // 69 at the canonical-model seed + `project.credentials.issue`, added by
    // 20260819015727000 when the cli-token / project-PAT routes stopped gating on
    // the coarse `manage` alias (routes.md §5.2).
    expect(seeded).toHaveLength(70);
    // The decisions, stated positively so a regression is unambiguous.
    expect(seeded).not.toContain('project.cr.open');
    expect(seeded).not.toContain('project.cr.merge');
    expect(seeded.filter((a) => a.startsWith('trigger.'))).toEqual([]);

    // scope_type is the ONE classifier: it must agree with scopeForActionV2 for
    // every action that still exists.
    const byAction = new Map(rows.map((r) => [r.action, r.scopeType]));
    expect(byAction.get('project.create')).toBe('account');
    expect(byAction.get('member.invite')).toBe('account');
    expect(byAction.get('project.gitops.push')).toBe('project');
    expect(byAction.get('project.session.start')).toBe('project');
  });

  test('delegable=false is exactly NON_DELEGABLE_ACTIONS', async () => {
    const rows = await db
      .select({ action: permissions.action, delegable: permissions.delegable })
      .from(permissions);
    const nonDelegable = rows.filter((r) => !r.delegable).map((r) => r.action).sort();
    expect(nonDelegable).toEqual([...NON_DELEGABLE_ACTIONS].sort());
    expect(nonDelegable).toHaveLength(17);
  });

  test('the 3 account system roles equal ACCOUNT_ROLE_PERMS', async () => {
    expect(await systemRoleActions('owner', 'account')).toEqual(expected(ACCOUNT_ROLE_PERMS.owner));
    expect(await systemRoleActions('admin', 'account')).toEqual(expected(ACCOUNT_ROLE_PERMS.admin));
    expect(await systemRoleActions('member', 'account')).toEqual(expected(ACCOUNT_ROLE_PERMS.member));
  });

  test('the 2 project system roles equal PROJECT_ROLE_PERMS', async () => {
    expect(await systemRoleActions('manager', 'project')).toEqual(expected(PROJECT_ROLE_PERMS.manager));
    expect(await systemRoleActions('member', 'project')).toEqual(expected(PROJECT_ROLE_PERMS.member));
  });

  test('agent-user carries ZERO permissions', async () => {
    // An object grant NARROWS a verdict and can never add one, so the role an
    // object assignment carries must grant nothing. If this ever gains an
    // action, every object grant silently becomes a privilege grant.
    expect(await systemRoleActions('agent-user', 'project')).toEqual([]);
  });

  test('every role_permissions action resolves to a catalog row', async () => {
    // The FK is NOT VALID (pre-existing rows are not checked), so assert it for
    // the rows the seed created.
    const rows = await db
      .select({ action: iamRoleActions.action })
      .from(iamRoleActions)
      .innerJoin(iamRoles, eq(iamRoles.roleId, iamRoleActions.roleId))
      .where(isNull(iamRoles.accountId));
    const catalog = new Set((await db.select({ action: permissions.action }).from(permissions)).map((r) => r.action));
    const orphans = [...new Set(rows.map((r) => r.action))].filter((a) => !catalog.has(a));
    expect(orphans).toEqual([]);
  });

  test('object_policies reproduces isProjectResourceUsableByMember', async () => {
    const rows = await db
      .select({
        objectType: objectPolicies.objectType,
        unscoped: objectPolicies.unscopedDefaultForMember,
      })
      .from(objectPolicies);
    const byType = new Map(rows.map((r) => [r.objectType, r.unscoped]));
    // Agents are deny-by-default for the member tier; everything else stays
    // project-wide when unscoped. That is the exact truth table of
    // iam/resource-grants.ts isProjectResourceUsableByMember.
    expect(byType.get('agent')).toBe('closed');
    expect(byType.get('skill')).toBe('open');
    expect(byType.get('secret')).toBe('open');
  });

  test('pendingPrincipalId matches Postgres uuid_generate_v5', async () => {
    // The backfill derives the `pending` principal in SQL; the accept path will
    // derive it in TypeScript. If the two ever disagree, an invitee's grants are
    // stranded under an id nothing looks up.
    const email = 'Parity.Invitee+tag@Example.COM';
    const rows = (await db.execute(
      sql`select uuid_generate_v5('b8d1f9c6-0a7e-4a2f-9d3b-5e6c7a8b9c01'::uuid, lower(${email})) as id`,
    )) as unknown as Array<{ id: string }>;
    expect(pendingPrincipalId(email)).toBe(rows[0].id);
  });
});
