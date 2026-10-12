// IAM v1 REST surface: DB-driven CUSTOM roles + their action sets + the
// policies that bind a principal (member/group/token) to a role at a scope.
// Backs the pre-built frontend SDK (apps/web/src/lib/iam-client.ts) whose
// /iam/roles, /iam/roles/:id/permissions, /iam/actions and /iam/policies calls
// 404'd until now. Built-in roles stay code-defined (role-perms.ts) and are
// surfaced here READ-ONLY (is_system) as presets/templates; only custom roles
// are editable and only custom roles can be bound via iam_policies.

import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, ne } from 'drizzle-orm';
import { iamRoleActions, iamRoles, projects } from '@kortix/db';
import { json, errors, auth } from '../../openapi';
import { db } from '../../shared/db';
import { accountCustomRoles, roleActionRows, systemRoleDescriptionRows } from '../../iam/role-read';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { FOLDER_ROLE_KEYS } from '../../iam/assignments';
import { countRoleBindings } from '../../iam/read-models';
import { actorOf } from '../../iam/actor';
import { invalidateIamCacheForRole } from '../../iam/cache-invalidation';
import { iamRouter, AccountIdParam } from './app';
import { registerPolicyListRoute, registerPolicyWriteRoutes, systemRoleWireId, isSystemRoleId, systemRoleByWireId, loadCustomRole } from './custom-roles-policy';
import { auditIam, isUniqueViolation, requireEntitlement } from './http-helpers';
import { readJsonObject } from '../../shared/http-body';
import { listAgentServiceAccounts, ensureAgentServiceAccount } from '../../repositories/service-accounts';
import { loadConfigWithFilesCached } from '../../projects/lib/project-resources';
import { ACTION_CATALOG_WIRE, validateActions } from './role-presets';
import { mapLimit } from '@kortix/registry';
import { TimeoutError, withTimeout } from '../../shared/with-timeout';

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
  'project:folder-reader',
  'project:folder-writer',
  'project:folder-manager',
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
  const rows = await systemRoleDescriptionRows();
  const rank = (r: { scopeType: string; key: string }) => {
    const i = SYSTEM_ROLE_ORDER.indexOf(`${r.scopeType}:${r.key}`);
    return i === -1 ? SYSTEM_ROLE_ORDER.length : i;
  };
  return rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
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

const Any = z.any();
const RoleIdParam = z.object({ accountId: z.string(), roleId: z.string() });

// ─── Auto-provisioned agent identities (picker principal source) ───────────
//
// EAGER provisioning: every agent in every active project is assignable
// WITHOUT having to launch it first. Enumerate the project configs and
// get-or-create an identity per agent (incl. the implicit `default`).
// Best-effort + bounded; a repo that won't load just keeps whatever's
// already provisioned. `ensureAgentServiceAccount` is idempotent, so this
// only mints on first sight. Capped to bound the git work on accounts with
// a very large project count (the picker is a manager-only admin surface).
//
// Incident (2026-09-27): unbounded `Promise.all` over up to 50 projects fired
// 50 concurrent git reads at once, each doing several sub-reads (manifest +
// file listing) — 201 total git operations, 22.9s, ending in a 503. Three
// independent fixes, all needed:
//  1. `loadConfigWithFilesCached` — a 20s per-project TTL memo (see
//     project-resources.ts) so a picker opened repeatedly (or by several
//     admins) doesn't re-clone the same handful of projects every time.
//  2. `mapLimit` bounds how many project reads run at once, instead of
//     firing all of them into the git layer simultaneously.
//  3. A whole-phase deadline: if eager provisioning is still running past the
//     budget, return whatever is already in `byKey` (already-provisioned
//     identities, plus any project this loop finished before the deadline)
//     instead of letting the request hang to a 503. The straggler work is
//     left to finish in the background; the next call sees it via the
//     config-load cache and/or the now-provisioned DB rows.
export const AGENT_IDENTITIES_PROJECT_CAP = 50;
export const AGENT_IDENTITIES_CONCURRENCY = 8;
export const AGENT_IDENTITIES_PER_PROJECT_BUDGET_MS = 4_000;
export const AGENT_IDENTITIES_PHASE_BUDGET_MS = 8_000;

export type AgentIdentity = {
  service_account_id: string;
  name: string;
  project_id: string | null;
  agent_name: string | null;
};

export type EagerProvisionProjectRow = Parameters<typeof loadConfigWithFilesCached>[0];

export interface EagerProvisionDeps {
  // `enabled` is optional on purpose: the config summary lists disabled agents
  // (`enabled: false`) and this loader may stand in for one.
  loadConfig: (row: EagerProvisionProjectRow) => Promise<{ agents: Array<{ name: string; enabled?: boolean }> }>;
  ensureAccount: (args: { accountId: string; projectId: string; agentName: string }) => Promise<string>;
  concurrency: number;
  perProjectBudgetMs: number;
  phaseBudgetMs: number;
}

const defaultEagerProvisionDeps: EagerProvisionDeps = {
  loadConfig: loadConfigWithFilesCached,
  ensureAccount: ensureAgentServiceAccount,
  concurrency: AGENT_IDENTITIES_CONCURRENCY,
  perProjectBudgetMs: AGENT_IDENTITIES_PER_PROJECT_BUDGET_MS,
  phaseBudgetMs: AGENT_IDENTITIES_PHASE_BUDGET_MS,
};

/**
 * Mutates `byKey` in place with every agent identity discovered across
 * `projectRows`, bounded by concurrency and a whole-phase deadline. Never
 * throws: a timeout (the whole phase, or one project's config load) degrades
 * to whatever is already in `byKey` rather than failing the picker. Deps are
 * injectable so a test can assert concurrency/timeout behavior without a real
 * DB or git mirror.
 */
export async function eagerlyProvisionAgentIdentities(
  accountId: string,
  projectRows: readonly EagerProvisionProjectRow[],
  byKey: Map<string, AgentIdentity>,
  deps: EagerProvisionDeps = defaultEagerProvisionDeps,
): Promise<void> {
  const eagerProvisioning = mapLimit(projectRows as EagerProvisionProjectRow[], deps.concurrency, async (p) => {
    let agentNames: string[] = ['default'];
    try {
      const config = await withTimeout(deps.loadConfig(p), deps.perProjectBudgetMs, 'agent-identities config load');
      // The config summary lists disabled agents too (enabled: false); an
      // identity for an agent no session can launch is noise in the picker.
      agentNames = ['default', ...config.agents.filter((a) => a.enabled !== false).map((a) => a.name)];
    } catch {
      // repo momentarily unreachable or slow — still expose the implicit
      // `default`.
    }
    for (const agentName of agentNames) {
      const key = `${p.projectId}|${agentName}`;
      if (byKey.has(key)) continue;
      try {
        const serviceAccountId = await deps.ensureAccount({ accountId, projectId: p.projectId, agentName });
        byKey.set(key, {
          service_account_id: serviceAccountId,
          name: `${agentName} · ${p.name}`,
          project_id: p.projectId,
          agent_name: agentName,
        });
      } catch {
        // minting unavailable (e.g. API_KEY_SECRET unset) — skip this agent.
      }
    }
  });
  try {
    await withTimeout(eagerProvisioning, deps.phaseBudgetMs, 'agent-identities eager provisioning');
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    // Degrade: answer with whatever's provisioned so far (already-provisioned
    // identities are always in `byKey`; the loop's stragglers finish in the
    // background and land on the next call). Never let a slow project 503 the
    // whole picker.
  }
}

export function registerIamCustomRolesRoutes(): void {
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
      const accountId = c.req.param('accountId');
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_READ);
      // Both halves from `kortix.iam_roles`: the seeded system rows (account_id
      // IS NULL) and this account's own. `is_system` is the column, not a
      // hardcoded `true` beside a code constant that could drift from the seed.
      const [system, custom] = await Promise.all([
        listSystemRolesWithDescription(),
        accountCustomRoles(accountId),
      ]);
      // The folder roles exist only as the level of a Files folder grant (the
      // Files access dialog sets them); they are not roles a person picks here.
      const listed = system.filter((r) => !(r.scopeType === 'project' && FOLDER_ROLE_KEYS.has(r.key)));
      return c.json({
        roles: [...listed.map(serializeSystemRole), ...custom.map(serializeCustomRole)],
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

      const body = await readJsonObject(c);
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!/^[a-z0-9_]{2,64}$/.test(key)) {
        return c.json({ error: 'key must be 2–64 chars of [a-z0-9_]' }, 400);
      }
      if (!name || name.length > 128) return c.json({ error: 'name is required (≤128 chars)' }, 400);
      const resourceType = body.resourceType === 'account' ? 'account' : 'project';
      const v = await validateActions(body.actions ?? [], resourceType);
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
      const accountId = c.req.param('accountId');
      const roleId = c.req.param('roleId');
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_UPDATE);
      const denied = await requireEntitlement(c, accountId, 'rbac');
      if (denied) return denied;
      if (await isSystemRoleId(roleId)) return c.json({ error: 'built-in roles cannot be edited' }, 400);
      const role = await loadCustomRole(accountId, roleId);
      if (!role) return c.json({ error: 'role not found' }, 404);

      const body = await readJsonObject(c);
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
      const rows = await roleActionRows(roleId);
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
      const accountId = c.req.param('accountId');
      const roleId = c.req.param('roleId');
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_UPDATE);
      const denied = await requireEntitlement(c, accountId, 'rbac');
      if (denied) return denied;
      if (await isSystemRoleId(roleId)) return c.json({ error: 'built-in role permissions are fixed' }, 400);
      const role = await loadCustomRole(accountId, roleId);
      if (!role) return c.json({ error: 'role not found' }, 404);

      const body = await readJsonObject(c);
      const v = await validateActions(body.actions ?? [], role.scopeType === 'account' ? 'account' : 'project');
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
      const accountId = c.req.param('accountId');
      const roleId = c.req.param('roleId');
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_READ);
      if (await isSystemRoleId(roleId)) return c.json({ role_id: roleId, policy_count: 0 });
      return c.json({ role_id: roleId, policy_count: await countRoleBindings(accountId, roleId) });
    },
  );

  registerPolicyListRoute();

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
      const accountId = c.req.param('accountId');
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_READ);

      const byKey = new Map<string, AgentIdentity>();
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

      const projectRows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.accountId, accountId), ne(projects.status, 'archived')))
        .limit(AGENT_IDENTITIES_PROJECT_CAP);

      await eagerlyProvisionAgentIdentities(accountId, projectRows, byKey);

      const agents = [...byKey.values()].sort(
        (a, b) =>
          (a.agent_name ?? '').localeCompare(b.agent_name ?? '') ||
          (a.project_id ?? '').localeCompare(b.project_id ?? ''),
      );
      return c.json({ agents });
    },
  );

  registerPolicyWriteRoutes();
}
