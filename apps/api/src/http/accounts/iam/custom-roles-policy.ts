import { createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { iamRoles, projects, serviceAccounts, accountMembers, accountGroups } from '@kortix/db';
import { json, errors, auth } from '../../openapi';
import { db } from '../../../lib/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../../services/iam';
import { actorOf } from '../../../services/iam/actor';
import { assignRole, revokeAssignment, updateAssignment, type AssignmentRow } from '../../../services/iam/assignments';
import type { ScopeType } from '../../../services/iam/catalog';
import { customRoleBindings, legacyToCanonicalPrincipal, type CustomRoleBinding } from '../../../services/iam/read-models';
import { invalidateIamCacheForPolicyPrincipal } from '../../../services/iam/cache-invalidation';
import { iamRouter, AccountIdParam } from './app';
import { auditIam, requireEntitlement } from '../../../services/accounts/iam/helpers';
import { readJsonObject } from '../../../lib/http-body';
import { loadSystemRoles } from '../../../services/iam/catalog';

export function systemRoleWireId(scopeType: string, key: string): string {
  return scopeType === 'project' && key === 'member' ? 'builtin:user' : `builtin:${key}`;
}

/** Is this a seeded system role's wire id? Answered from the DB, not a constant. */
export async function isSystemRoleId(roleId: string): Promise<boolean> {
  return (await systemRoleByWireId(roleId)) !== null;
}

/** The seeded role a wire id names, with its action set from `role_permissions`. */
export async function systemRoleByWireId(wireId: string) {
  const roles = await loadSystemRoles();
  for (const role of roles.byId.values()) {
    if (systemRoleWireId(role.scopeType, role.key) === wireId) return role;
  }
  return null;
}

export async function loadCustomRole(accountId: string, roleId: string) {
  const [row] = await db
    .select()
    .from(iamRoles)
    .where(and(eq(iamRoles.roleId, roleId), eq(iamRoles.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

const Any = z.any();
const PolicyIdParam = z.object({ accountId: z.string(), policyId: z.string() });

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
 * ONE id space as of the cutover: `kortix.iam_policies` is a view over
 * `kortix.role_assignments` whose `policy_id` IS the assignment id, so the two
 * eras this used to reconcile are the same number. A genuinely pre-cutover
 * `policy_id` — held by a page rendered before the migration ran — no longer
 * resolves and gets a 404; reloading the page yields the current id.
 */
async function resolveBindingId(
  accountId: string,
  id: string,
): Promise<CustomRoleBinding | null> {
  const [binding] = (await customRoleBindings({ accountId })).filter((b) => b.policyId === id);
  return binding ?? null;
}

// ─── Policies (principal → custom role @ scope) ─────────────────────────────
export function registerPolicyListRoute() {

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

}

export function registerPolicyWriteRoutes() {
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

    const body = await readJsonObject(c);
    const parsed = await parsePolicyInput(accountId, body);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

    // THE write: it enforces the delegability ceiling (a role carrying a
    // non-delegable action cannot be BOUND, not just created), busts the caches,
    // and emits the single `iam.assignment.granted` event. `kortix.iam_policies`
    // is a view over the row it writes.
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
    const before = {
      principal_type: target.principalType,
      principal_id: target.principalId,
      role_id: target.roleId,
    };
    // The route asserted policy.delete; `revokeAssignment` would otherwise
    // re-derive policy.create for a custom role.
    await revokeAssignment(await actorOf(c, accountId), accountId, policyId, {
      skipWriterAuthz: true,
    });
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
    const body = await readJsonObject(c);
    const ids = Array.isArray(body.policy_ids) ? body.policy_ids.filter((x: unknown): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return c.json({ deleted: 0 });
    const writer = await actorOf(c, accountId);
    let deleted = 0;
    for (const id of ids) {
      const target = await resolveBindingId(accountId, id);
      if (!target) continue;
      await revokeAssignment(writer, accountId, id, { skipWriterAuthz: true });
      await invalidateIamCacheForPolicyPrincipal(target.principalType, target.principalId);
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

    const existing = await resolveBindingId(accountId, policyId);
    if (!existing) return c.json({ error: 'policy not found' }, 404);

    const body = await readJsonObject(c);
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

    // An in-place re-point, NOT revoke+grant: the id is part of this route's
    // contract, and a caller that PATCHes then DELETEs holds it.
    const writer = await actorOf(c, accountId);
    const assignment: AssignmentRow = await updateAssignment(writer, accountId, policyId, {
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

    const body = await readJsonObject(c);
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
        // `assignRole` upserts on the assignment identity, which is what makes
        // the import idempotent — `iam_policies` had no unique constraint at
        // all, so re-importing the same file used to create duplicates.
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

}

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
