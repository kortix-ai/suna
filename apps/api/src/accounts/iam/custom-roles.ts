// IAM v1 REST surface: DB-driven CUSTOM roles + their action sets + the
// policies that bind a principal (member/group/token) to a role at a scope.
// Backs the pre-built frontend SDK (apps/web/src/lib/iam-client.ts) whose
// /iam/roles, /iam/roles/:id/permissions, /iam/actions and /iam/policies calls
// 404'd until now. Built-in roles stay code-defined (role-perms.ts) and are
// surfaced here READ-ONLY (is_system) as presets/templates; only custom roles
// are editable and only custom roles can be bound via iam_policies.

import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { iamPolicies, iamRoleActions, iamRoles, projects, serviceAccounts } from '@kortix/db';
import { json, errors, auth } from '../../openapi';
import { db } from '../../shared/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import {
  invalidateIamCacheForPolicyPrincipal,
  invalidateIamCacheForRole,
} from '../../iam/cache-invalidation';
import { iamRouter, AccountIdParam } from './app';
import { auditIam, isUniqueViolation, readBody } from './helpers';
import { listAgentServiceAccounts } from '../../repositories/service-accounts';
import {
  ACTION_CATALOG_WIRE,
  BUILTIN_BY_ID,
  BUILTIN_PRESETS,
  validateActions,
  type BuiltinPreset,
} from './role-presets';

// ─── Serializers (match iam-client.ts wire shapes exactly) ──────────────────

function serializeBuiltinRole(p: BuiltinPreset) {
  return {
    role_id: `builtin:${p.key}`,
    key: p.key,
    name: p.name,
    description: p.description,
    resource_type: p.resourceType,
    is_system: true,
    account_id: null as string | null,
  };
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

// v1 is allow-only with no conditions: every persisted policy is an unconditional
// allow. We surface effect/conditions so the pre-built UI renders, but only
// 'allow' / {} are accepted on write.
function serializePolicy(p: typeof iamPolicies.$inferSelect) {
  return {
    policy_id: p.policyId,
    principal_type: p.principalType,
    principal_id: p.principalId,
    scope_type: p.scopeType,
    scope_id: p.scopeId,
    role_id: p.roleId,
    effect: 'allow' as const,
    conditions: {},
    expires_at: p.expiresAt ? p.expiresAt.toISOString() : null,
    created_by: p.grantedBy,
    created_at: p.createdAt.toISOString(),
  };
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);
    const custom = await db.select().from(iamRoles).where(eq(iamRoles.accountId, accountId));
    return c.json({
      roles: [...BUILTIN_PRESETS.map(serializeBuiltinRole), ...custom.map(serializeCustomRole)],
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_CREATE);

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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_UPDATE);
    if (BUILTIN_BY_ID.has(roleId)) return c.json({ error: 'built-in roles cannot be edited' }, 400);
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_DELETE);
    if (BUILTIN_BY_ID.has(roleId)) return c.json({ error: 'built-in roles cannot be deleted' }, 400);
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);

    const builtin = BUILTIN_BY_ID.get(roleId);
    if (builtin) return c.json({ role_id: roleId, key: builtin.key, actions: [...builtin.actions] });

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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_UPDATE);
    if (BUILTIN_BY_ID.has(roleId)) return c.json({ error: 'built-in role permissions are fixed' }, 400);
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);
    if (BUILTIN_BY_ID.has(roleId)) return c.json({ role_id: roleId, policy_count: 0 });
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(iamPolicies)
      .where(and(eq(iamPolicies.roleId, roleId), eq(iamPolicies.accountId, accountId)))
      .limit(1);
    return c.json({ role_id: roleId, policy_count: Number(row?.n ?? 0) });
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_READ);

    const conds = [eq(iamPolicies.accountId, accountId)];
    const pt = c.req.query('principalType');
    const pid = c.req.query('principalId');
    const st = c.req.query('scopeType');
    const sid = c.req.query('scopeId');
    if (pt) conds.push(eq(iamPolicies.principalType, pt));
    if (pid) conds.push(eq(iamPolicies.principalId, pid));
    if (st) conds.push(eq(iamPolicies.scopeType, st));
    if (sid === 'null') conds.push(isNull(iamPolicies.scopeId));
    else if (sid) conds.push(eq(iamPolicies.scopeId, sid));

    const rows = await db.select().from(iamPolicies).where(and(...conds));
    return c.json({ policies: rows.map(serializePolicy) });
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_READ);
    const rows = await listAgentServiceAccounts(accountId);
    return c.json({
      agents: rows.map((r) => ({
        service_account_id: r.serviceAccountId,
        name: r.name,
        project_id: r.projectId,
        agent_name: r.agentName,
      })),
    });
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_CREATE);

    const body = await readBody(c);
    const parsed = await parsePolicyInput(accountId, body);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

    const [row] = await db
      .insert(iamPolicies)
      .values({
        accountId,
        principalType: parsed.value.principalType,
        principalId: parsed.value.principalId,
        roleId: parsed.value.roleId,
        scopeType: parsed.value.scopeType,
        scopeId: parsed.value.scopeId,
        expiresAt: parsed.value.expiresAt,
        grantedBy: userId,
      })
      .returning();
    await invalidateIamCacheForPolicyPrincipal(parsed.value.principalType, parsed.value.principalId);
    await auditIam(c, {
      accountId,
      action: 'iam.policy.create',
      resourceType: 'account',
      resourceId: row!.policyId,
      after: {
        principal_type: parsed.value.principalType,
        principal_id: parsed.value.principalId,
        role_id: parsed.value.roleId,
        scope_type: parsed.value.scopeType,
        scope_id: parsed.value.scopeId,
      },
    });
    return c.json(serializePolicy(row!), 201);
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_DELETE);

    const [row] = await db
      .delete(iamPolicies)
      .where(and(eq(iamPolicies.policyId, policyId), eq(iamPolicies.accountId, accountId)))
      .returning();
    if (!row) return c.json({ error: 'policy not found' }, 404);
    await invalidateIamCacheForPolicyPrincipal(row.principalType, row.principalId);
    await auditIam(c, {
      accountId,
      action: 'iam.policy.delete',
      resourceType: 'account',
      resourceId: policyId,
      before: { principal_type: row.principalType, principal_id: row.principalId, role_id: row.roleId },
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_DELETE);
    const body = await readBody(c);
    const ids = Array.isArray(body.policy_ids) ? body.policy_ids.filter((x: unknown): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return c.json({ deleted: 0 });
    const rows = await db
      .delete(iamPolicies)
      .where(and(eq(iamPolicies.accountId, accountId), inArray(iamPolicies.policyId, ids)))
      .returning({ principalType: iamPolicies.principalType, principalId: iamPolicies.principalId });
    for (const r of rows) await invalidateIamCacheForPolicyPrincipal(r.principalType, r.principalId);
    return c.json({ deleted: rows.length });
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_CREATE);

    const [existing] = await db
      .select()
      .from(iamPolicies)
      .where(and(eq(iamPolicies.policyId, policyId), eq(iamPolicies.accountId, accountId)))
      .limit(1);
    if (!existing) return c.json({ error: 'policy not found' }, 404);

    const body = await readBody(c);
    // Re-validate the scope/role/effect/expiry using the same rules as create,
    // re-using the existing principal (PATCH never moves a policy to a new
    // principal — delete + create for that).
    const parsed = await parsePolicyInput(accountId, {
      ...body,
      principalType: existing.principalType,
      principalId: existing.principalId,
    });
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

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
    return c.json(serializePolicy(row!));
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_CREATE);

    const body = await readBody(c);
    const entries = Array.isArray(body.policies) ? (body.policies as Array<Record<string, unknown>>) : [];
    // Resolve role keys → ids once (custom roles only; built-ins aren't bindable).
    const customRoles = await db.select().from(iamRoles).where(eq(iamRoles.accountId, accountId));
    const roleIdByKey = new Map(customRoles.map((r) => [r.key, r.roleId]));

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
): Promise<
  | { ok: true; value: { principalType: string; principalId: string; roleId: string; scopeType: string; scopeId: string | null; expiresAt: Date | null } }
  | { ok: false; status: 400 | 404; error: string }
> {
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
  if (principalType === 'token') {
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
  if (BUILTIN_BY_ID.has(roleId)) {
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
