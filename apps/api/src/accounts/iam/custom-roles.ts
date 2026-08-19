// IAM v1 REST surface: DB-driven CUSTOM roles + their action sets + the
// policies that bind a principal (member/group/token) to a role at a scope.
// Backs the pre-built frontend SDK (apps/web/src/lib/iam-client.ts) whose
// /iam/roles, /iam/roles/:id/permissions, /iam/actions and /iam/policies calls
// 404'd until now. Built-in roles stay code-defined (role-perms.ts) and are
// surfaced here READ-ONLY (is_system) as presets/templates; only custom roles
// are editable and only custom roles can be bound via iam_policies.

import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { iamPolicies, iamRoleActions, iamRoles, projects, serviceAccounts, accountMembers, accountGroups } from '@kortix/db';
import { json, errors, auth } from '../../openapi';
import { db } from '../../shared/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { loadSystemRoles } from '../../iam/catalog';
import { countRoleBindings } from '../../iam/read-models';
import { actorOf } from '../../iam/actor';
import {
  assignRole,
  revokeAssignment,
  updateAssignment,
  type AssignmentRow,
} from '../../iam/assignments';
import type { ScopeType } from '../../iam/catalog';
import {
  customRoleBindings,
  legacyToCanonicalPrincipal,
  type CustomRoleBinding,
} from '../../iam/read-models';
import {
  invalidateIamCacheForPolicyPrincipal,
  invalidateIamCacheForRole,
} from '../../iam/cache-invalidation';
import { iamRouter, AccountIdParam } from './app';
import { auditIam, isUniqueViolation, readBody, requireEntitlement } from './helpers';
import { listAgentServiceAccounts, ensureAgentServiceAccount } from '../../repositories/service-accounts';
import { loadConfigWithFiles } from '../../projects/lib/project-resources';
import { ACTION_CATALOG_WIRE, validateActions } from './role-presets';

// ─── Serializers (match iam-client.ts wire shapes exactly) ──────────────────

/**
 * The stable WIRE ID of a seeded system role.
 *
 * `builtin:<key>`, not the row's uuid: published clients hold these ids, and
 * `isSystemRoleId` is what makes "built-in roles cannot be edited, deleted or
 * bound as a policy" a 400 instead of a 404.
 *
 * ONE alias, and it is an id alias only: the project floor role's key in the
 * store is `member`, but `builtin:member` was already taken by the ACCOUNT
 * floor role, so the project one keeps the id `builtin:user` it has always had.
 * The `key` FIELD carries the store's key (`member`), which is what makes it
 * usable as `role_key` on `POST /iam/assignments` — the round-trip that was
 * broken while this list was built from a code constant.
 */
function systemRoleWireId(scopeType: string, key: string): string {
  return scopeType === 'project' && key === 'member' ? 'builtin:user' : `builtin:${key}`;
}

/** Is this a seeded system role's wire id? Answered from the DB, not a constant. */
async function isSystemRoleId(roleId: string): Promise<boolean> {
  return (await systemRoleByWireId(roleId)) !== null;
}

function serializeSystemRole(r: {
  key: string;
  name: string;
  description: string | null;
  scopeType: string;
}) {
  return {
    role_id: systemRoleWireId(r.scopeType, r.key),
    key: r.key,
    name: r.name,
    description: r.description,
    resource_type: (r.scopeType === 'account' ? 'account' : 'project') as 'account' | 'project',
    is_system: true,
    account_id: null as string | null,
  };
}

/** The render order the role editor has always used. */
const SYSTEM_ROLE_ORDER = [
  'project:manager',
  'project:member',
  'account:owner',
  'account:admin',
  'account:member',
  'project:agent-user',
];

/**
 * EVERY seeded system role, from `kortix.iam_roles` (account_id IS NULL).
 *
 * Including `agent-user`, which carries zero permissions and exists only so an
 * object assignment has a role to point at. It is listed because it IS a system
 * role and the guards below have to recognise it — omitting it made
 * `PATCH /iam/roles/builtin:agent-user` answer "role not found" instead of
 * "built-in roles cannot be edited".
 */
async function listSystemRolesWithDescription() {
  const rows = await db
    .select({
      key: iamRoles.key,
      name: iamRoles.name,
      description: iamRoles.description,
      scopeType: iamRoles.scopeType,
    })
    .from(iamRoles)
    .where(isNull(iamRoles.accountId));
  const rank = (r: { scopeType: string; key: string }) => {
    const i = SYSTEM_ROLE_ORDER.indexOf(`${r.scopeType}:${r.key}`);
    return i === -1 ? SYSTEM_ROLE_ORDER.length : i;
  };
  return rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

/** The seeded role a wire id names, with its action set from `role_permissions`. */
async function systemRoleByWireId(wireId: string) {
  const roles = await loadSystemRoles();
  for (const role of roles.byId.values()) {
    if (systemRoleWireId(role.scopeType, role.key) === wireId) return role;
  }
  return null;
}

function serializeCustomRole(r: typeof iamRoles.$inferSelect) {
  return {
    role_id: r.roleId,
    key: r.key,
    name: r.name,
    description: r.description,
    resource_type: (r.scopeType === 'account' ? 'account' : 'project') as 'account' | 'project',
    is_system: false,
    account_id: r.accountId,
  };
}

// Allow-only with no conditions: every binding is an unconditional allow. We
// surface effect/conditions so the pre-built UI renders, but only 'allow' / {}
// are accepted on write.
//
// `policy_id` is the ASSIGNMENT id. `iam_policies.policy_id` is not on the wire
// any more — the assignment is the row that exists — and DELETE/PATCH accept
// either id so a client holding a pre-cutover one still works.
function serializeBinding(b: CustomRoleBinding) {
  return {
    policy_id: b.policyId,
    principal_type: b.principalType,
    principal_id: b.principalId,
    scope_type: b.scopeType,
    scope_id: b.scopeId,
    role_id: b.roleId,
    effect: 'allow' as const,
    conditions: {},
    expires_at: b.expiresAt ? b.expiresAt.toISOString() : null,
    created_by: b.grantedBy,
    created_at: b.createdAt.toISOString(),
  };
}

/** The same wire shape, straight off an `assignRole` result. */
function serializeAssignment(row: AssignmentRow) {
  return {
    policy_id: row.assignmentId,
    principal_type:
      row.principalType === 'user'
        ? 'member'
        : row.principalType === 'service_account'
          ? 'token'
          : row.principalType,
    principal_id: row.principalId,
    scope_type: row.scopeType,
    scope_id: row.scopeId,
    role_id: row.roleId,
    effect: 'allow' as const,
    conditions: {},
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    created_by: row.grantedBy,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Resolve an id the client sent to the binding it names.
 *
 * Two eras of id reach these routes: an `iam_policies.policy_id` from a
 * pre-cutover response, and an assignment id from every response since. Both
 * revoke the same access, and both paths remove BOTH rows — the legacy delete
 * through the mirror trigger, the canonical one through `revokeAssignment`.
 */
async function resolveBindingId(
  accountId: string,
  id: string,
): Promise<{ kind: 'legacy'; row: typeof iamPolicies.$inferSelect } | { kind: 'assignment'; row: CustomRoleBinding } | null> {
  const [legacy] = await db
    .select()
    .from(iamPolicies)
    .where(and(eq(iamPolicies.policyId, id), eq(iamPolicies.accountId, accountId)))
    .limit(1);
  if (legacy) return { kind: 'legacy', row: legacy };
  const [binding] = (await customRoleBindings({ accountId })).filter((b) => b.policyId === id);
  return binding ? { kind: 'assignment', row: binding } : null;
}

const Any = z.any();
const RoleIdParam = z.object({ accountId: z.string(), roleId: z.string() });
const PolicyIdParam = z.object({ accountId: z.string(), policyId: z.string() });

async function loadCustomRole(accountId: string, roleId: string) {
  const [row] = await db
    .select()
    .from(iamRoles)
    .where(and(eq(iamRoles.roleId, roleId), eq(iamRoles.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

// ─── Actions catalog ────────────────────────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/actions',
    tags: ['iam'],
    summary: 'List the action catalog (for the role permission matrix)',
    ...auth,
    request: { params: AccountIdParam },
    responses: { 200: json(z.object({ actions: z.array(Any) }), 'Action catalog'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_READ);
    return c.json({ actions: ACTION_CATALOG_WIRE });
  },
);

// ─── Roles ────────────────────────────────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/roles',
    tags: ['iam'],
    summary: 'List built-in presets + custom roles',
    ...auth,
    request: { params: AccountIdParam },
    responses: { 200: json(z.object({ roles: z.array(Any) }), 'Roles'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_READ);
    // Both halves from `kortix.iam_roles`: the seeded system rows (account_id
    // IS NULL) and this account's own. `is_system` is the column, not a
    // hardcoded `true` beside a code constant that could drift from the seed.
    const [system, custom] = await Promise.all([
      listSystemRolesWithDescription(),
      db.select().from(iamRoles).where(eq(iamRoles.accountId, accountId)),
    ]);
    return c.json({
      roles: [...system.map(serializeSystemRole), ...custom.map(serializeCustomRole)],
    });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/roles',
    tags: ['iam'],
    summary: 'Create a custom role',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: Any } } } },
    responses: { 201: json(Any, 'Created role'), ...errors(400, 401, 403, 409) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_CREATE);
    const denied = await requireEntitlement(c, accountId, 'rbac');
    if (denied) return denied;

    const body = await readBody(c);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!/^[a-z0-9_]{2,64}$/.test(key)) {
      return c.json({ error: 'key must be 2–64 chars of [a-z0-9_]' }, 400);
    }
    if (!name || name.length > 128) return c.json({ error: 'name is required (≤128 chars)' }, 400);
    const resourceType = body.resourceType === 'account' ? 'account' : 'project';
    const v = validateActions(body.actions ?? [], resourceType);
    if (!v.ok) return c.json({ error: v.error }, 400);

    try {
      const [role] = await db
        .insert(iamRoles)
        .values({
          accountId,
          key,
          name,
          description: typeof body.description === 'string' ? body.description : null,
          scopeType: resourceType,
          createdBy: userId,
        })
        .returning();
      if (v.actions.length > 0) {
        await db.insert(iamRoleActions).values(v.actions.map((action) => ({ roleId: role!.roleId, action })));
      }
      await auditIam(c, {
        accountId,
        action: 'iam.role.create',
        resourceType: 'account',
        resourceId: role!.roleId,
        after: { key, name, scope_type: resourceType, action_count: v.actions.length },
      });
      return c.json(serializeCustomRole(role!), 201);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return c.json({ error: 'a role with this key already exists' }, 409);
      throw err;
    }
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/roles/{roleId}',
    tags: ['iam'],
    summary: 'Rename / describe a custom role',
    ...auth,
    request: { params: RoleIdParam, body: { content: { 'application/json': { schema: Any } } } },
    responses: { 200: json(Any, 'Updated role'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const roleId = c.req.param('roleId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_UPDATE);
    const denied = await requireEntitlement(c, accountId, 'rbac');
    if (denied) return denied;
    if (await isSystemRoleId(roleId)) return c.json({ error: 'built-in roles cannot be edited' }, 400);
    const role = await loadCustomRole(accountId, roleId);
    if (!role) return c.json({ error: 'role not found' }, 404);

    const body = await readBody(c);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.name === 'string') {
      if (!body.name.trim() || body.name.length > 128) return c.json({ error: 'invalid name' }, 400);
      patch.name = body.name.trim();
    }
    if (body.description === null || typeof body.description === 'string') {
      patch.description = body.description;
    }
    const [updated] = await db
      .update(iamRoles)
      .set(patch)
      .where(and(eq(iamRoles.roleId, roleId), eq(iamRoles.accountId, accountId)))
      .returning();
    return c.json(serializeCustomRole(updated!));
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/roles/{roleId}',
    tags: ['iam'],
    summary: 'Delete a custom role (cascades its policies)',
    ...auth,
    request: { params: RoleIdParam },
    responses: { 200: json(z.object({ deleted: z.boolean() }), 'Deleted'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const roleId = c.req.param('roleId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_DELETE);
    // No entitlement gate: deleting a role is cleanup — a downgraded account
    // must always be able to remove custom roles it can no longer manage.
    if (await isSystemRoleId(roleId)) return c.json({ error: 'built-in roles cannot be deleted' }, 400);
    const role = await loadCustomRole(accountId, roleId);
    if (!role) return c.json({ error: 'role not found' }, 404);

    // Bust caches for everyone holding this role BEFORE the cascade removes the
    // policies we'd look them up from.
    await invalidateIamCacheForRole(roleId);
    await db.delete(iamRoles).where(and(eq(iamRoles.roleId, roleId), eq(iamRoles.accountId, accountId)));
    await auditIam(c, {
      accountId,
      action: 'iam.role.delete',
      resourceType: 'account',
      resourceId: roleId,
      before: { key: role.key, name: role.name },
    });
    return c.json({ deleted: true });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/roles/{roleId}/permissions',
    tags: ['iam'],
    summary: 'Get a role’s action set',
    ...auth,
    request: { params: RoleIdParam },
    responses: { 200: json(z.object({ role_id: z.string(), key: z.string(), actions: z.array(z.string()) }), 'Actions'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const roleId = c.req.param('roleId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_READ);

    if (await isSystemRoleId(roleId)) {
      // From `role_permissions`, not from the code preset: the seed is the
      // source of truth for what a system role grants, and the engine expands
      // the same rows.
      const system = await systemRoleByWireId(roleId);
      if (!system) return c.json({ error: 'role not found' }, 404);
      return c.json({
        role_id: roleId,
        key: system.key,
        actions: [...system.actions].sort(),
      });
    }

    const role = await loadCustomRole(accountId, roleId);
    if (!role) return c.json({ error: 'role not found' }, 404);
    const rows = await db.select({ action: iamRoleActions.action }).from(iamRoleActions).where(eq(iamRoleActions.roleId, roleId));
    return c.json({ role_id: roleId, key: role.key, actions: rows.map((r) => r.action) });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/iam/roles/{roleId}/permissions',
    tags: ['iam'],
    summary: 'Replace a custom role’s action set (the capability matrix)',
    ...auth,
    request: { params: RoleIdParam, body: { content: { 'application/json': { schema: Any } } } },
    responses: { 200: json(z.object({ role_id: z.string(), actions: z.array(z.string()) }), 'Updated'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const roleId = c.req.param('roleId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_UPDATE);
    const denied = await requireEntitlement(c, accountId, 'rbac');
    if (denied) return denied;
    if (await isSystemRoleId(roleId)) return c.json({ error: 'built-in role permissions are fixed' }, 400);
    const role = await loadCustomRole(accountId, roleId);
    if (!role) return c.json({ error: 'role not found' }, 404);

    const body = await readBody(c);
    const v = validateActions(body.actions ?? [], role.scopeType === 'account' ? 'account' : 'project');
    if (!v.ok) return c.json({ error: v.error }, 400);

    // Replace the set atomically, then bust everyone holding the role so the new
    // capabilities (or deactivations) apply immediately.
    await db.transaction(async (tx) => {
      await tx.delete(iamRoleActions).where(eq(iamRoleActions.roleId, roleId));
      if (v.actions.length > 0) {
        await tx.insert(iamRoleActions).values(v.actions.map((action) => ({ roleId, action })));
      }
      await tx.update(iamRoles).set({ updatedAt: new Date() }).where(eq(iamRoles.roleId, roleId));
    });
    await invalidateIamCacheForRole(roleId);
    await auditIam(c, {
      accountId,
      action: 'iam.role.permissions.set',
      resourceType: 'account',
      resourceId: roleId,
      after: { action_count: v.actions.length },
    });
    return c.json({ role_id: roleId, actions: v.actions });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/roles/{roleId}/usage',
    tags: ['iam'],
    summary: 'How many policies reference this role',
    ...auth,
    request: { params: RoleIdParam },
    responses: { 200: json(z.object({ role_id: z.string(), policy_count: z.number() }), 'Usage'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const roleId = c.req.param('roleId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_READ);
    if (await isSystemRoleId(roleId)) return c.json({ role_id: roleId, policy_count: 0 });
    return c.json({ role_id: roleId, policy_count: await countRoleBindings(accountId, roleId) });
  },
);

// ─── Policies (principal → custom role @ scope) ─────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/policies',
    tags: ['iam'],
    summary: 'List policies (optionally filtered)',
    ...auth,
    request: { params: AccountIdParam },
    responses: { 200: json(z.object({ policies: z.array(Any) }), 'Policies'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_READ);

    const pt = c.req.query('principalType');
    const pid = c.req.query('principalId');
    const st = c.req.query('scopeType');
    const sid = c.req.query('scopeId');
    // An unknown principalType selects nothing, exactly as an equality filter
    // on the old column did.
    if (pt && pt !== 'member' && pt !== 'group' && pt !== 'token') {
      return c.json({ policies: [] });
    }
    if (st && st !== 'account' && st !== 'project') return c.json({ policies: [] });

    const rows = await customRoleBindings({
      accountId,
      ...(pt ? { principalType: pt as 'member' | 'group' | 'token' } : {}),
      ...(pid ? { principalId: pid } : {}),
      ...(st ? { scopeType: st as ScopeType } : {}),
      ...(sid === 'null' ? { scopeId: null } : sid ? { scopeId: sid } : {}),
    });
    return c.json({ policies: rows.map(serializeBinding) });
  },
);

// Auto-provisioned agent identities — the principal picker for binding a role to
// an agent (promoting it to a standing teammate). Read-gated like policies.
iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/agent-identities',
    tags: ['iam'],
    summary: 'List agent service-account identities (policy principal picker)',
    ...auth,
    request: { params: AccountIdParam },
    responses: { 200: json(z.object({ agents: z.array(Any) }), 'Agent identities'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_READ);

    type Identity = { service_account_id: string; name: string; project_id: string | null; agent_name: string | null };
    const byKey = new Map<string, Identity>();
    // Start from already-provisioned identities (the implicit `default` + any
    // agent that has been launched). Keyed (project, agent) to dedupe.
    for (const r of await listAgentServiceAccounts(accountId)) {
      byKey.set(`${r.projectId}|${r.agentName}`, {
        service_account_id: r.serviceAccountId,
        name: r.name,
        project_id: r.projectId,
        agent_name: r.agentName,
      });
    }

    // EAGER provisioning: every agent in every active project is assignable
    // WITHOUT having to launch it first. Enumerate the project configs and
    // get-or-create an identity per agent (incl. the implicit `default`).
    // Best-effort + parallel; a repo that won't load just keeps whatever's
    // already provisioned. ensureAgentServiceAccount is idempotent, so this
    // only mints on first sight. Capped to bound the git work on accounts with
    // a very large project count (the picker is a manager-only admin surface).
    const PROJECT_CAP = 50;
    const projectRows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.accountId, accountId), ne(projects.status, 'archived')))
      .limit(PROJECT_CAP);
    await Promise.all(
      projectRows.map(async (p) => {
        let agentNames: string[] = ['default'];
        try {
          const config = await loadConfigWithFiles(p);
          agentNames = ['default', ...config.agents.map((a) => a.name)];
        } catch {
          // repo momentarily unreachable — still expose the implicit `default`.
        }
        for (const agentName of agentNames) {
          const key = `${p.projectId}|${agentName}`;
          if (byKey.has(key)) continue;
          try {
            const serviceAccountId = await ensureAgentServiceAccount({ accountId, projectId: p.projectId, agentName });
            byKey.set(key, { service_account_id: serviceAccountId, name: `${agentName} · ${p.name}`, project_id: p.projectId, agent_name: agentName });
          } catch {
            // minting unavailable (e.g. API_KEY_SECRET unset) — skip this agent.
          }
        }
      }),
    );

    const agents = [...byKey.values()].sort(
      (a, b) =>
        (a.agent_name ?? '').localeCompare(b.agent_name ?? '') ||
        (a.project_id ?? '').localeCompare(b.project_id ?? ''),
    );
    return c.json({ agents });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/policies',
    tags: ['iam'],
    summary: 'Bind a principal to a custom role at a scope',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: Any } } } },
    responses: { 201: json(Any, 'Created policy'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_CREATE);
    const denied = await requireEntitlement(c, accountId, 'rbac');
    if (denied) return denied;

    const body = await readBody(c);
    const parsed = await parsePolicyInput(accountId, body);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

    await db.insert(iamPolicies).values({
      accountId,
      principalType: parsed.value.principalType,
      principalId: parsed.value.principalId,
      roleId: parsed.value.roleId,
      scopeType: parsed.value.scopeType,
      scopeId: parsed.value.scopeId,
      expiresAt: parsed.value.expiresAt,
      grantedBy: userId,
    });
    // …and the canonical binding, through the ONE write path: it enforces the
    // delegability ceiling (a role carrying a non-delegable action can no
    // longer be BOUND, not just created), busts the caches, and emits the
    // single `iam.assignment.granted` event. The mirror trigger already wrote
    // the same identity inside the INSERT above, so the upsert here produces
    // one row, not two.
    const assignment = await assignRole(await actorOf(c, accountId), accountId, {
      principal: {
        type: legacyToCanonicalPrincipal(parsed.value.principalType)!,
        id: parsed.value.principalId,
      },
      roleId: parsed.value.roleId,
      scope: { type: parsed.value.scopeType as ScopeType, id: parsed.value.scopeId },
      expiresAt: parsed.value.expiresAt,
      source: 'manual',
    });
    await invalidateIamCacheForPolicyPrincipal(parsed.value.principalType, parsed.value.principalId);
    await auditIam(c, {
      accountId,
      action: 'iam.policy.create',
      resourceType: 'account',
      resourceId: assignment.assignmentId,
      after: {
        principal_type: parsed.value.principalType,
        principal_id: parsed.value.principalId,
        role_id: parsed.value.roleId,
        scope_type: parsed.value.scopeType,
        scope_id: parsed.value.scopeId,
      },
    });
    return c.json(serializeAssignment(assignment), 201);
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/policies/{policyId}',
    tags: ['iam'],
    summary: 'Delete a policy',
    ...auth,
    request: { params: PolicyIdParam },
    responses: { 200: json(z.object({ deleted: z.boolean() }), 'Deleted'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const policyId = c.req.param('policyId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_DELETE);
    // No entitlement gate: revoking a policy binding is cleanup, always allowed.

    const target = await resolveBindingId(accountId, policyId);
    if (!target) return c.json({ error: 'policy not found' }, 404);
    const before =
      target.kind === 'legacy'
        ? {
            principal_type: target.row.principalType,
            principal_id: target.row.principalId,
            role_id: target.row.roleId,
          }
        : {
            principal_type: target.row.principalType,
            principal_id: target.row.principalId,
            role_id: target.row.roleId,
          };
    if (target.kind === 'legacy') {
      // The mirror trigger drops the canonical row inside this statement.
      await db
        .delete(iamPolicies)
        .where(and(eq(iamPolicies.policyId, policyId), eq(iamPolicies.accountId, accountId)));
    } else {
      // The route asserted policy.delete; `revokeAssignment` would otherwise
      // re-derive policy.create for a custom role. It removes the legacy row in
      // the same transaction, so a pre-cutover replica cannot resurrect it.
      await revokeAssignment(await actorOf(c, accountId), accountId, policyId, {
        skipWriterAuthz: true,
      });
    }
    await invalidateIamCacheForPolicyPrincipal(before.principal_type, before.principal_id);
    await auditIam(c, {
      accountId,
      action: 'iam.policy.delete',
      resourceType: 'account',
      resourceId: policyId,
      before,
    });
    return c.json({ deleted: true });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/policies:bulk-delete',
    tags: ['iam'],
    summary: 'Delete multiple policies',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: Any } } } },
    responses: { 200: json(z.object({ deleted: z.number() }), 'Deleted count'), ...errors(400, 401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_DELETE);
    // No entitlement gate: bulk policy revocation is cleanup, always allowed.
    const body = await readBody(c);
    const ids = Array.isArray(body.policy_ids) ? body.policy_ids.filter((x: unknown): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return c.json({ deleted: 0 });
    // Ids of both eras can appear in one batch (a page rendered before the
    // cutover, revoked after it), so each is resolved on its own.
    const writer = await actorOf(c, accountId);
    let deleted = 0;
    for (const id of ids) {
      const target = await resolveBindingId(accountId, id);
      if (!target) continue;
      if (target.kind === 'legacy') {
        await db
          .delete(iamPolicies)
          .where(and(eq(iamPolicies.policyId, id), eq(iamPolicies.accountId, accountId)));
      } else {
        await revokeAssignment(writer, accountId, id, { skipWriterAuthz: true });
      }
      await invalidateIamCacheForPolicyPrincipal(
        target.row.principalType,
        target.row.principalId,
      );
      deleted++;
    }
    return c.json({ deleted });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/policies/{policyId}',
    tags: ['iam'],
    summary: 'Change a policy’s role / scope / expiry (principal is immutable)',
    ...auth,
    request: { params: PolicyIdParam, body: { content: { 'application/json': { schema: Any } } } },
    responses: { 200: json(Any, 'Updated policy'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    const policyId = c.req.param('policyId');
    // Editing an assignment is a create-class action — gate on POLICY_CREATE.
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_CREATE);
    const denied = await requireEntitlement(c, accountId, 'rbac');
    if (denied) return denied;

    const target = await resolveBindingId(accountId, policyId);
    if (!target) return c.json({ error: 'policy not found' }, 404);
    const existing = target.row;

    const body = await readBody(c);
    // Re-validate the scope/role/effect/expiry using the same rules as create,
    // re-using the existing principal (PATCH never moves a policy to a new
    // principal — delete + create for that).
    const parsed = await parsePolicyInput(
      accountId,
      {
        ...body,
        principalType: existing.principalType,
        principalId: existing.principalId,
      },
      // The principal is immutable on PATCH — don't re-validate its account
      // membership (a since-removed member must not 404 a scope/role/expiry edit).
      { validatePrincipal: false },
    );
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

    // A binding's identity IS (principal, role, scope) — changing any of them
    // is a different assignment, so the edit is a revoke plus a grant, not an
    // in-place UPDATE of an immutable key. The legacy row is updated too while
    // it still exists, so a pre-cutover replica sees the same change.
    const writer = await actorOf(c, accountId);
    let assignment: AssignmentRow;
    if (target.kind === 'legacy') {
      // The legacy row is still the one the mirror trigger derives from, so
      // updating it re-points the canonical row for free.
      const [row] = await db
        .update(iamPolicies)
        .set({
          roleId: parsed.value.roleId,
          scopeType: parsed.value.scopeType,
          scopeId: parsed.value.scopeId,
          expiresAt: parsed.value.expiresAt,
          updatedAt: new Date(),
        })
        .where(and(eq(iamPolicies.policyId, policyId), eq(iamPolicies.accountId, accountId)))
        .returning();
      await invalidateIamCacheForPolicyPrincipal(existing.principalType, existing.principalId);
      await auditIam(c, {
        accountId,
        action: 'iam.policy.update',
        resourceType: 'account',
        resourceId: policyId,
        after: { role_id: parsed.value.roleId, scope_type: parsed.value.scopeType, scope_id: parsed.value.scopeId },
      });
      return c.json(serializeBinding({
        policyId: row!.policyId,
        accountId,
        principalType: row!.principalType as CustomRoleBinding['principalType'],
        principalId: row!.principalId,
        roleId: row!.roleId,
        roleKey: '',
        roleName: '',
        scopeType: row!.scopeType as ScopeType,
        scopeId: row!.scopeId,
        expiresAt: row!.expiresAt,
        grantedBy: row!.grantedBy,
        createdAt: row!.createdAt,
        updatedAt: row!.updatedAt ?? row!.createdAt,
      }));
    }
    // An in-place re-point, NOT revoke+grant: the id is part of this route's
    // contract, and a caller that PATCHes then DELETEs holds it.
    assignment = await updateAssignment(writer, accountId, policyId, {
      roleId: parsed.value.roleId,
      scope: { type: parsed.value.scopeType as ScopeType, id: parsed.value.scopeId },
      expiresAt: parsed.value.expiresAt,
    });
    await invalidateIamCacheForPolicyPrincipal(existing.principalType, existing.principalId);
    await auditIam(c, {
      accountId,
      action: 'iam.policy.update',
      resourceType: 'account',
      resourceId: assignment.assignmentId,
      after: { role_id: parsed.value.roleId, scope_type: parsed.value.scopeType, scope_id: parsed.value.scopeId },
    });
    return c.json(serializeAssignment(assignment));
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/policies:bulk-import',
    tags: ['iam'],
    summary: 'Create many policies, referencing roles by key (portable import)',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: Any } } } },
    responses: { 200: json(Any, 'Import result'), ...errors(400, 401, 403) },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_CREATE);
    const denied = await requireEntitlement(c, accountId, 'rbac');
    if (denied) return denied;

    const body = await readBody(c);
    const entries = Array.isArray(body.policies) ? (body.policies as Array<Record<string, unknown>>) : [];
    // Resolve role keys → ids once (custom roles only; built-ins aren't bindable).
    const customRoles = await db.select().from(iamRoles).where(eq(iamRoles.accountId, accountId));
    const roleIdByKey = new Map(customRoles.map((r) => [r.key, r.roleId]));

    const importer = await actorOf(c, accountId);
    const result = { attempted: entries.length, created: 0, skipped: 0, errors: [] as Array<{ index: number; error: string }> };
    const bustedPrincipals: Array<{ t: string; id: string }> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const roleKey = typeof e.role_key === 'string' ? e.role_key : '';
      const roleId = roleIdByKey.get(roleKey);
      if (!roleId) {
        result.errors.push({ index: i, error: `unknown role_key: ${roleKey}` });
        result.skipped++;
        continue;
      }
      const parsed = await parsePolicyInput(accountId, {
        principalType: e.principal_type,
        principalId: e.principal_id,
        scopeType: e.scope_type,
        scopeId: e.scope_id,
        roleId,
        effect: e.effect,
        expires_at: e.expires_at,
      });
      if (!parsed.ok) {
        result.errors.push({ index: i, error: parsed.error });
        result.skipped++;
        continue;
      }
      // Catch per-row insert failures so one bad row becomes a skip (matching the
      // partial-success contract) rather than aborting the batch with a 500 and
      // leaving earlier rows committed.
      try {
        await db.insert(iamPolicies).values({
          accountId,
          principalType: parsed.value.principalType,
          principalId: parsed.value.principalId,
          roleId: parsed.value.roleId,
          scopeType: parsed.value.scopeType,
          scopeId: parsed.value.scopeId,
          expiresAt: parsed.value.expiresAt,
          grantedBy: userId,
        });
        // …and the canonical binding. This is also what makes the import
        // idempotent: `assignRole` upserts on the assignment identity, where
        // the legacy table has no unique constraint at all and re-importing the
        // same file used to create duplicates.
        await assignRole(importer, accountId, {
          principal: {
            type: legacyToCanonicalPrincipal(parsed.value.principalType)!,
            id: parsed.value.principalId,
          },
          roleId: parsed.value.roleId,
          scope: { type: parsed.value.scopeType as ScopeType, id: parsed.value.scopeId },
          expiresAt: parsed.value.expiresAt,
          source: 'manual',
        });
      } catch (err) {
        result.errors.push({ index: i, error: err instanceof Error ? err.message : 'insert failed' });
        result.skipped++;
        continue;
      }
      bustedPrincipals.push({ t: parsed.value.principalType, id: parsed.value.principalId });
      result.created++;
    }
    for (const p of bustedPrincipals) await invalidateIamCacheForPolicyPrincipal(p.t, p.id);
    await auditIam(c, {
      accountId,
      action: 'iam.policy.bulk_import',
      resourceType: 'account',
      resourceId: accountId,
      after: { attempted: result.attempted, created: result.created, skipped: result.skipped },
    });
    return c.json(result);
  },
);

// Shared policy-input parser/validator (v1: allow-only, conditions ignored).
async function parsePolicyInput(
  accountId: string,
  body: Record<string, unknown>,
  // PATCH re-runs this with the EXISTING (immutable) principal, so it must not
  // re-validate principal ownership — a member who later left the account would
  // otherwise 404 a legitimate scope/role/expiry edit of an already-bound policy.
  opts: { validatePrincipal?: boolean } = {},
): Promise<
  | { ok: true; value: { principalType: string; principalId: string; roleId: string; scopeType: string; scopeId: string | null; expiresAt: Date | null } }
  | { ok: false; status: 400 | 404; error: string }
> {
  const validatePrincipal = opts.validatePrincipal !== false;
  const principalType = String(body.principalType ?? '');
  // 'token' = a service-account (machine identity) principal. The engine now
  // resolves these (engine-v2 resolveActorV2 → service_accounts branch), so an
  // SA's own iam_policies are its STANDING role. member/group bind humans.
  if (!['member', 'group', 'token'].includes(principalType)) {
    return { ok: false, status: 400, error: 'principalType must be member, group, or token' };
  }
  const principalId = typeof body.principalId === 'string' ? body.principalId : '';
  if (!principalId) return { ok: false, status: 400, error: 'principalId is required' };

  // A token principal must be an active service account in THIS account — else
  // the policy is a dangling no-op (or a cross-account reference). Mirrors the
  // project scopeId ownership check below.
  if (validatePrincipal && principalType === 'token') {
    const [sa] = await db
      .select({ id: serviceAccounts.serviceAccountId })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.serviceAccountId, principalId),
          eq(serviceAccounts.accountId, accountId),
          eq(serviceAccounts.status, 'active'),
        ),
      )
      .limit(1);
    if (!sa) return { ok: false, status: 404, error: 'principalId does not match an active service account in this account' };
  }

  // Ownership parity for member/group principals: binding a foreign user/group id
  // creates an inert policy (the engine resolves by account membership) — reject
  // it with a clear error instead, matching the token + project ownership checks.
  if (validatePrincipal && principalType === 'member') {
    const [m] = await db
      .select({ id: accountMembers.userId })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, principalId), eq(accountMembers.accountId, accountId)))
      .limit(1);
    if (!m) return { ok: false, status: 404, error: 'principalId is not a member of this account' };
  }
  if (validatePrincipal && principalType === 'group') {
    const [g] = await db
      .select({ id: accountGroups.groupId })
      .from(accountGroups)
      .where(and(eq(accountGroups.groupId, principalId), eq(accountGroups.accountId, accountId)))
      .limit(1);
    if (!g) return { ok: false, status: 404, error: 'principalId is not a group in this account' };
  }

  const scopeType = String(body.scopeType ?? '');
  if (!['account', 'project'].includes(scopeType)) {
    return { ok: false, status: 400, error: 'scopeType must be account or project' };
  }
  // An agent / service-account identity is project-bound by nature. An
  // ACCOUNT-scoped role on it would grant account-wide powers the per-session
  // agent-grant fold does NOT narrow (the fold only gates project scope) — a
  // standing-identity escalation surface. Keep token principals project-scoped.
  if (principalType === 'token' && scopeType === 'account') {
    return { ok: false, status: 400, error: 'service-account (agent) policies must be project-scoped' };
  }
  const scopeId = typeof body.scopeId === 'string' && body.scopeId ? body.scopeId : null;
  if (scopeType === 'project' && !scopeId) {
    return { ok: false, status: 400, error: 'scopeId (project id) is required for project scope' };
  }
  // A project-scoped policy must target a project that actually belongs to this
  // account — otherwise a typo'd or cross-account scopeId creates a dangling
  // policy that silently grants nothing (or, worse, hints at cross-tenant
  // intent). Validate existence + ownership up front.
  if (scopeType === 'project' && scopeId) {
    const [proj] = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(and(eq(projects.projectId, scopeId), eq(projects.accountId, accountId)))
      .limit(1);
    if (!proj) return { ok: false, status: 404, error: 'scopeId does not match a project in this account' };
  }

  if (body.effect !== undefined && body.effect !== 'allow') {
    return { ok: false, status: 400, error: 'only effect="allow" is supported (deny is not in v1)' };
  }

  const roleId = typeof body.roleId === 'string' ? body.roleId : '';
  if (!roleId) return { ok: false, status: 400, error: 'roleId is required' };
  if (await isSystemRoleId(roleId)) {
    return { ok: false, status: 400, error: 'built-in roles are assigned via project members/groups, not policies' };
  }
  const role = await loadCustomRole(accountId, roleId);
  if (!role) return { ok: false, status: 404, error: 'role not found in this account' };

  // Scope integrity: a policy must bind a role at the role's own scope. An
  // account-scoped policy grants its role's actions across the WHOLE account
  // (engine-v2 customPolicyAllows returns true for any target when
  // scopeType==='account'), so binding a project "department" role at account
  // scope would silently smear it over every project — a broadening the role's
  // author never intended. Project roles bind at project scope, account roles
  // at account scope.
  if (role.scopeType !== scopeType) {
    return {
      ok: false,
      status: 400,
      error: `scopeType must be "${role.scopeType}" to match this role's scope`,
    };
  }

  let expiresAt: Date | null = null;
  if (typeof body.expires_at === 'string' && body.expires_at) {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime())) return { ok: false, status: 400, error: 'expires_at must be ISO-8601' };
    // A policy that's already expired is a no-op the engine filters out
    // (expiresAt > now()); accepting one masks intent — reject it loudly.
    if (d.getTime() <= Date.now()) {
      return { ok: false, status: 400, error: 'expires_at is in the past' };
    }
    expiresAt = d;
  }

  return { ok: true, value: { principalType, principalId, roleId, scopeType, scopeId, expiresAt } };
}
