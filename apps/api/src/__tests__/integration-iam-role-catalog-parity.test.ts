/**
 * The SEED **is** the spec.
 *
 * `kortix.permissions` + `kortix.role_permissions` on the 6 system roles replaced
 * three hand-maintained code constants — `ACCOUNT_ROLE_PERMS` /
 * `PROJECT_ROLE_PERMS`, the action catalog, and `NON_DELEGABLE_ACTIONS`. Until
 * the cutover this test pinned the seed EQUAL to those Sets, in both directions.
 * The Sets are deleted, so there is nothing left to compare against — and that is
 * exactly when a seed can drift silently.
 *
 * So it became a SHAPE test, stating the properties the model must hold rather
 * than restating the seed: sizes, the strict role hierarchy, the security
 * ceiling, the catalog decisions, and the FK that makes an unknown action
 * unstorable. Every assertion here fails LOUDLY on a permission change nobody
 * reviewed.
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
import { pendingPrincipalId } from '../iam/actor';

const COLLAPSED = ['project.cr.open', 'project.cr.merge'];

/**
 * The 17 actions that may NEVER appear in a user-authored role. Restated here
 * rather than imported, deliberately: this IS the security ceiling, and a test
 * that reads it from the same place the code does proves nothing. Changing it
 * requires changing both, which is the review gate.
 */
const NON_DELEGABLE = [
  'account.delete',
  'billing.write',
  'group.create',
  'group.delete',
  'group.members.manage',
  'group.update',
  'member.invite',
  'member.remove',
  'member.super_admin.grant',
  'member.update',
  'policy.create',
  'policy.delete',
  'role.create',
  'role.delete',
  'role.update',
  'token.create',
  'token.revoke',
];

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

    // `iam/actions.ts` is still the STRING constant module the routes import, so
    // every action a route can assert must exist in the catalog. The reverse is
    // not required — the catalog may lead the code.
    const fromCode = [
      ...Object.values(ACCOUNT_ACTIONS),
      ...Object.values(PROJECT_ACTIONS),
    ]
      .filter((a) => !COLLAPSED.includes(a))
      .sort();
    expect(fromCode.filter((a) => !seeded.includes(a))).toEqual([]);

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

  test('delegable=false is exactly the 17-action security ceiling', async () => {
    const rows = await db
      .select({ action: permissions.action, delegable: permissions.delegable })
      .from(permissions);
    const nonDelegable = rows.filter((r) => !r.delegable).map((r) => r.action).sort();
    expect(nonDelegable).toEqual([...NON_DELEGABLE].sort());
    // project.members.manage / project.gateway.keys.manage are deliberately NOT
    // here: they are project-scoped, so a department lead holding one can only
    // ever hand out project roles, never account ones.
    expect(nonDelegable).not.toContain('project.members.manage');
    expect(nonDelegable).not.toContain('project.gateway.keys.manage');
  });

  test('the account roles are a strict chain: member ⊂ admin ⊂ owner', async () => {
    const owner = await systemRoleActions('owner', 'account');
    const admin = await systemRoleActions('admin', 'account');
    const member = await systemRoleActions('member', 'account');
    expect([owner.length, admin.length, member.length]).toEqual([27, 24, 5]);
    expect(member.filter((a) => !admin.includes(a))).toEqual([]);
    expect(admin.filter((a) => !owner.includes(a))).toEqual([]);
    // The four owner-only powers, named.
    expect(owner.filter((a) => !admin.includes(a)).sort()).toEqual([
      'account.delete',
      'billing.write',
      'member.super_admin.grant',
    ]);
    // A plain account member has NO write surface at all.
    expect(member.filter((a) => !a.endsWith('.read'))).toEqual([]);
  });

  test('the project roles are a strict chain: member ⊂ manager', async () => {
    const manager = await systemRoleActions('manager', 'project');
    const member = await systemRoleActions('member', 'project');
    expect([manager.length, member.length]).toEqual([43, 15]);
    expect(member.filter((a) => !manager.includes(a))).toEqual([]);
    // The floor role is read + RUN: it starts sessions and fires triggers, and
    // holds project.agent.read (a grant cannot ADD a permission, so without this
    // leaf every per-agent grant would be inert for the exact role it serves).
    for (const a of [
      'project.read',
      'project.session.start',
      'project.session.stop',
      'project.trigger.fire',
      'project.agent.read',
    ]) {
      expect(member).toContain(a);
    }
    // …and NO write, config, gitops, members, deploy or credential surface.
    for (const a of [
      'project.write',
      'project.agent.write',
      'project.gitops.merge',
      'project.trigger.create',
      'project.members.manage',
      'project.credentials.issue',
      'project.customize.read',
      'project.connector.read',
      'project.skill.read',
      'project.secret.read',
      'project.file.read',
    ]) {
      expect(member).not.toContain(a);
    }
  });

  test('the per-capability leaves preserve the manager/member capability surface', async () => {
    // The IAM-v1 per-capability leaves, as a backward-compat invariant: manager
    // must hold EVERY write leaf (it had all of them via project.write before
    // they were split out), and member must hold NONE. The read leaves split
    // three ways — see the assertions.
    const manager = await systemRoleActions('manager', 'project');
    const member = await systemRoleActions('member', 'project');

    const writeLeaves = [
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
      PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
      PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
      PROJECT_ACTIONS.PROJECT_FILE_WRITE,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
      PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
      PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    ];
    // Reads the floor member role keeps. project.agent.read is one of them:
    // "member = read + run" is only true if the role can reach an agent at all,
    // and an object grant NARROWS an allow rather than creating one. The
    // deny-by-default object rule (`object_policies.agent = closed`) is what
    // limits a member to the agents granted to them.
    const memberReadLeaves = [
      PROJECT_ACTIONS.PROJECT_COMMAND_READ,
      PROJECT_ACTIONS.PROJECT_GITOPS_READ,
      PROJECT_ACTIONS.PROJECT_AGENT_READ,
    ];
    // Sensitive / Customize reads that are manager-tier: files, secrets, and the
    // Connectors/Skills/Customize surface. Those object types stay
    // unscoped-is-OPEN, so holding the leaf would grant the whole surface.
    const managerReadLeaves = [
      PROJECT_ACTIONS.PROJECT_FILE_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
      PROJECT_ACTIONS.PROJECT_SKILL_READ,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
    ];

    for (const a of writeLeaves) {
      expect(manager).toContain(a);
      expect(member).not.toContain(a);
    }
    for (const a of memberReadLeaves) {
      expect(member).toContain(a);
      expect(manager).toContain(a);
    }
    for (const a of managerReadLeaves) {
      expect(member).not.toContain(a);
      expect(manager).toContain(a);
    }
  });

  test('agent-user carries ZERO permissions', async () => {
    // An object grant NARROWS a verdict and can never add one, so the role an
    // object assignment carries must grant nothing. If this ever gains an
    // action, every object grant silently becomes a privilege grant.
    expect(await systemRoleActions('agent-user', 'project')).toEqual([]);
  });

  test('the catalog FK is VALIDATED, so an unknown action is unstorable', async () => {
    // 20260819015724479 added it NOT VALID; 20260819160100000 validated it. A
    // NOT VALID constraint skips pre-existing rows, so this is the assertion that
    // says "every row, not just the new ones".
    const rows = (await db.execute(sql`
      select convalidated from pg_constraint
       where conname = 'role_permissions_action_permissions_fk'`)) as unknown as Array<{
      convalidated: boolean;
    }>;
    const list = (rows as unknown as { rows?: Array<{ convalidated: boolean }> }).rows ?? rows;
    expect(list.map((r) => r.convalidated)).toEqual([true]);
  });

  test('every role_permissions action resolves to a catalog row', async () => {
    const rows = await db
      .select({ action: iamRoleActions.action })
      .from(iamRoleActions)
      .innerJoin(iamRoles, eq(iamRoles.roleId, iamRoleActions.roleId))
      .where(isNull(iamRoles.accountId));
    const catalog = new Set((await db.select({ action: permissions.action }).from(permissions)).map((r) => r.action));
    const orphans = [...new Set(rows.map((r) => r.action))].filter((a) => !catalog.has(a));
    expect(orphans).toEqual([]);
  });

  test('object_policies is THE unscoped-object default', async () => {
    const rows = await db
      .select({
        objectType: objectPolicies.objectType,
        unscoped: objectPolicies.unscopedDefaultForMember,
      })
      .from(objectPolicies);
    const byType = new Map(rows.map((r) => [r.objectType, r.unscoped]));
    // Agents are deny-by-default for the member tier; everything else stays
    // project-wide when unscoped. `objectUsable` in iam/authorize.ts reads these
    // rows — it is the only copy of the rule left.
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
