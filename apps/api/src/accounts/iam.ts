// IAM REST surface — groups, policies, roles, super-admin promotion, and
// effective-permissions probe. Mounted under accountsRouter at
// /v1/accounts/:accountId/iam/*. Auth is inherited from the parent router
// (supabaseAuth populates userId). Every handler asserts the relevant IAM
// action via assertAuthorized().

import { Context, Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accounts,
  iamPolicies,
  projectMembers,
} from '@kortix/db';
import { db } from '../shared/db';
import type { AppEnv } from '../types';
import {
  ACCOUNT_ACTIONS,
  ACTION_CATALOG,
  VALID_ACTIONS,
  assertAuthorized,
  authorize,
  resourceTypeForAction,
  type ResourceType,
  type PolicyConditions,
} from '../iam';
import { assertValidCidr } from '../shared/cidr';
import {
  addGroupMembers,
  countPoliciesUsingRole,
  createCustomRole,
  createGroup,
  createPolicy,
  deleteCustomRole,
  deleteGroup,
  deletePolicy,
  getGroup,
  getPolicyById,
  getRoleById,
  getRolePermissions,
  listGroupMembers,
  listGroups,
  listGroupsForMember,
  listPolicies,
  listRoles,
  removeGroupMember,
  replaceRolePermissions,
  updateCustomRole,
  updateGroup,
  updatePolicy,
  type IamPolicy,
  type PolicyFilter,
} from '../repositories/iam';
import { recordAuditEvent } from '../shared/audit';
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
} from '../repositories/scim';

export const iamRouter = new Hono<AppEnv>();

const VALID_RESOURCE_TYPES: readonly ResourceType[] = [
  'account',
  'project',
  'sandbox',
  'trigger',
  'channel',
  'member',
  'group',
];

function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && (VALID_RESOURCE_TYPES as readonly string[]).includes(value);
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

// Compact snapshot shape for audit before/after fields. The full policy row
// has timestamps and created_by which add noise to an audit diff — we keep
// just the semantically-meaningful tuple.
function snapshotPolicy(p: IamPolicy) {
  return {
    policy_id: p.policyId,
    principal_type: p.principalType,
    principal_id: p.principalId,
    scope_type: p.scopeType,
    scope_id: p.scopeId,
    role_id: p.roleId,
    effect: p.effect,
    conditions: p.conditions,
  };
}

/**
 * Validate & normalise the optional `conditions` field from a request body.
 * Returns the cleaned object (possibly empty) on success; returns an error
 * string the route should bounce back to the client on failure.
 *
 * Strict rules:
 *   - Top-level value must be an object (or absent → {}).
 *   - `ip_cidrs` must be string[]; every entry must parse as IP or CIDR.
 *   - `require_mfa` must be boolean.
 *   - Unknown keys are silently dropped (forward-compat with v2 fields).
 */
function parseConditions(raw: unknown): { ok: true; value: PolicyConditions } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'conditions must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const out: PolicyConditions = {};

  if ('ip_cidrs' in obj) {
    const raw = obj.ip_cidrs;
    if (!Array.isArray(raw)) {
      return { ok: false, error: 'conditions.ip_cidrs must be an array of strings' };
    }
    const cleaned: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        return { ok: false, error: 'conditions.ip_cidrs entries must be strings' };
      }
      const trimmed = entry.trim();
      if (!trimmed) continue; // skip blanks the UI may submit
      try {
        cleaned.push(assertValidCidr(trimmed));
      } catch {
        return { ok: false, error: `conditions.ip_cidrs: invalid IP or CIDR '${entry}'` };
      }
    }
    if (cleaned.length > 100) {
      return { ok: false, error: 'conditions.ip_cidrs: maximum 100 entries' };
    }
    if (cleaned.length > 0) out.ip_cidrs = cleaned;
  }

  if ('require_mfa' in obj) {
    const raw = obj.require_mfa;
    if (typeof raw !== 'boolean') {
      return { ok: false, error: 'conditions.require_mfa must be a boolean' };
    }
    if (raw) out.require_mfa = true; // omit when false to keep object compact
  }

  return { ok: true, value: out };
}

/**
 * Audit helper bound to the request context. The global middleware already
 * logs a coarse "POST /v1/accounts/.../iam/policies" row for every state
 * change; these explicit calls add the before/after detail that makes "who
 * granted X to Y on Z date" a single audit_events query.
 */
async function auditIam(
  c: Context,
  args: {
    accountId: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
) {
  try {
    await recordAuditEvent({
      accountId: args.accountId,
      actorUserId: c.get('userId') as string | undefined,
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId ?? null,
      before: args.before ?? null,
      after: args.after ?? null,
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        null,
      userAgent: c.req.header('user-agent') || null,
    });
  } catch (err) {
    // Audit failures must not break the mutation that succeeded. Log loudly
    // so it surfaces in monitoring; downgrade to console.warn if we end up
    // alerting on console.error.
    console.error('[iam audit] failed to write audit event', args.action, err);
  }
}

/**
 * Drizzle wraps the raw postgres-js error inside DrizzleQueryError as `cause`.
 * The wrapper's `message` is the formatted "Failed query: …" string, which
 * never matches "unique"/"duplicate" — we have to drill into the cause and
 * check the Postgres SQLSTATE. 23505 = unique_violation.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause && cause.code === '23505') return true;
  // Belt-and-braces: some adapters surface the code on the top-level error.
  if ((err as { code?: string }).code === '23505') return true;
  return false;
}

// ─── Groups ────────────────────────────────────────────────────────────────

iamRouter.get('/:accountId/iam/groups', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_READ);

  const rows = await listGroups(accountId);
  return c.json({
    groups: rows.map((g) => ({
      group_id: g.groupId,
      name: g.name,
      description: g.description,
      source: g.source,
      member_count: g.memberCount,
      policy_count: g.policyCount,
      created_at: g.createdAt.toISOString(),
      updated_at: g.updatedAt.toISOString(),
    })),
  });
});

iamRouter.post('/:accountId/iam/groups', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_CREATE);

  const body = await readBody(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 128) return c.json({ error: 'name too long' }, 400);

  const description =
    typeof body.description === 'string' ? body.description : null;

  try {
    const group = await createGroup({ accountId, name, description, createdBy: userId });

    await auditIam(c, {
      accountId,
      action: 'iam.group.create',
      resourceType: 'account_group',
      resourceId: group.groupId,
      after: { name: group.name, description: group.description, source: group.source },
    });

    return c.json(
      {
        group_id: group.groupId,
        name: group.name,
        description: group.description,
        source: group.source,
        created_at: group.createdAt.toISOString(),
      },
      201,
    );
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A group with this name already exists' }, 409);
    }
    throw err;
  }
});

iamRouter.get('/:accountId/iam/groups/:groupId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_READ);

  const group = await getGroup(accountId, groupId);
  if (!group) return c.json({ error: 'group not found' }, 404);

  return c.json({
    group_id: group.groupId,
    name: group.name,
    description: group.description,
    source: group.source,
    external_id: group.externalId,
    created_at: group.createdAt.toISOString(),
    updated_at: group.updatedAt.toISOString(),
  });
});

iamRouter.patch('/:accountId/iam/groups/:groupId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_UPDATE, {
    type: 'group',
    id: groupId,
  });

  const body = await readBody(c);
  const patch: { name?: string; description?: string | null } = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name || name.length > 128) return c.json({ error: 'invalid name' }, 400);
    patch.name = name;
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' ? body.description : null;
  }

  const beforeGroup = await getGroup(accountId, groupId);

  const updated = await updateGroup(accountId, groupId, patch);
  if (!updated) return c.json({ error: 'group not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.group.update',
    resourceType: 'account_group',
    resourceId: groupId,
    before: beforeGroup
      ? { name: beforeGroup.name, description: beforeGroup.description }
      : null,
    after: { name: updated.name, description: updated.description },
  });

  return c.json({
    group_id: updated.groupId,
    name: updated.name,
    description: updated.description,
    updated_at: updated.updatedAt.toISOString(),
  });
});

iamRouter.delete('/:accountId/iam/groups/:groupId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_DELETE, {
    type: 'group',
    id: groupId,
  });

  const beforeGroup = await getGroup(accountId, groupId);

  const ok = await deleteGroup(accountId, groupId);
  if (!ok) return c.json({ error: 'group not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.group.delete',
    resourceType: 'account_group',
    resourceId: groupId,
    before: beforeGroup
      ? { name: beforeGroup.name, description: beforeGroup.description, source: beforeGroup.source }
      : null,
  });

  return c.json({ deleted: true });
});

// ─── Group members ─────────────────────────────────────────────────────────

iamRouter.get('/:accountId/iam/groups/:groupId/members', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_READ);

  const members = await listGroupMembers(accountId, groupId);
  return c.json({
    members: members.map((m) => ({
      user_id: m.userId,
      added_at: m.addedAt.toISOString(),
      added_by: m.addedBy,
    })),
  });
});

iamRouter.post('/:accountId/iam/groups/:groupId/members', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_MEMBERS_MANAGE, {
    type: 'group',
    id: groupId,
  });

  const group = await getGroup(accountId, groupId);
  if (!group) return c.json({ error: 'group not found' }, 404);

  const body = await readBody(c);
  const userIds: string[] = Array.isArray(body.userIds)
    ? body.userIds.filter((v): v is string => typeof v === 'string')
    : typeof body.userId === 'string'
      ? [body.userId]
      : [];
  if (userIds.length === 0) return c.json({ error: 'userIds required' }, 400);

  const result = await addGroupMembers({ accountId, groupId, userIds, addedBy: userId });

  if (result.added > 0) {
    await auditIam(c, {
      accountId,
      action: 'iam.group.members.add',
      resourceType: 'account_group',
      resourceId: groupId,
      after: { added_user_ids: userIds, added_count: result.added },
    });
  }

  return c.json({ added: result.added });
});

iamRouter.delete('/:accountId/iam/groups/:groupId/members/:userId', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  const targetUserId = c.req.param('userId');
  await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.GROUP_MEMBERS_MANAGE, {
    type: 'group',
    id: groupId,
  });

  const group = await getGroup(accountId, groupId);
  if (!group) return c.json({ error: 'group not found' }, 404);

  const ok = await removeGroupMember(groupId, targetUserId);
  if (!ok) return c.json({ error: 'not a member of this group' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.group.members.remove',
    resourceType: 'account_group',
    resourceId: groupId,
    before: { removed_user_id: targetUserId },
  });

  return c.json({ removed: true });
});

// ─── Policies ──────────────────────────────────────────────────────────────

iamRouter.get('/:accountId/iam/policies', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_READ);

  const filter: PolicyFilter = {};
  const principalType = c.req.query('principalType');
  if (principalType === 'member' || principalType === 'group' || principalType === 'token') {
    filter.principalType = principalType;
  }
  const principalId = c.req.query('principalId');
  if (principalId) filter.principalId = principalId;
  const scopeType = c.req.query('scopeType');
  if (isResourceType(scopeType)) filter.scopeType = scopeType;
  const scopeId = c.req.query('scopeId');
  if (scopeId === 'null') filter.scopeId = null;
  else if (scopeId) filter.scopeId = scopeId;

  const rows = await listPolicies(accountId, filter);
  return c.json({
    policies: rows.map((p) => ({
      policy_id: p.policyId,
      principal_type: p.principalType,
      principal_id: p.principalId,
      scope_type: p.scopeType,
      scope_id: p.scopeId,
      role_id: p.roleId,
      effect: p.effect,
      conditions: p.conditions,
      created_by: p.createdBy,
      created_at: p.createdAt.toISOString(),
    })),
  });
});

iamRouter.post('/:accountId/iam/policies', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_CREATE);

  const body = await readBody(c);
  const principalType = body.principalType ?? body.principal_type;
  if (principalType !== 'member' && principalType !== 'group' && principalType !== 'token') {
    return c.json({ error: 'principalType must be member|group|token' }, 400);
  }
  const principalId = (body.principalId ?? body.principal_id) as unknown;
  if (typeof principalId !== 'string' || !principalId) {
    return c.json({ error: 'principalId is required' }, 400);
  }
  const scopeType = body.scopeType ?? body.scope_type;
  if (!isResourceType(scopeType)) {
    return c.json({ error: 'scopeType must be a valid resource type' }, 400);
  }
  const rawScopeId = body.scopeId ?? body.scope_id;
  const scopeId: string | null =
    typeof rawScopeId === 'string' && rawScopeId.length > 0 ? rawScopeId : null;
  if (scopeType === 'account' && scopeId !== null) {
    return c.json({ error: 'scope_type=account requires scope_id to be null' }, 400);
  }
  if (scopeType !== 'account' && scopeId === null) {
    return c.json({ error: 'resource-specific scopes require a scope_id' }, 400);
  }
  const roleId = (body.roleId ?? body.role_id) as unknown;
  if (typeof roleId !== 'string' || !roleId) {
    return c.json({ error: 'roleId is required' }, 400);
  }
  const effectRaw = body.effect ?? 'allow';
  if (effectRaw !== 'allow' && effectRaw !== 'deny') {
    return c.json({ error: 'effect must be allow or deny' }, 400);
  }
  const effect = effectRaw as 'allow' | 'deny';

  const conditionsResult = parseConditions(body.conditions);
  if (!conditionsResult.ok) return c.json({ error: conditionsResult.error }, 400);
  const conditions = conditionsResult.value;

  // Role must exist and be available to this account (system or own).
  const role = await getRoleById(accountId, roleId);
  if (!role) return c.json({ error: 'unknown role' }, 404);

  // Sanity: role's resource_type should match the scope_type.
  if (role.resourceType !== scopeType && role.resourceType !== 'account') {
    return c.json(
      {
        error: `role '${role.key}' is for ${role.resourceType} scope; cannot attach at ${scopeType} scope`,
      },
      400,
    );
  }

  // If principal is a member, they must actually be a member of this account.
  if (principalType === 'member') {
    const [m] = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, principalId)),
      )
      .limit(1);
    if (!m) return c.json({ error: 'principal is not a member of this account' }, 404);
  } else if (principalType === 'group') {
    const group = await getGroup(accountId, principalId);
    if (!group) return c.json({ error: 'group not found' }, 404);
  }

  const policy = await createPolicy({
    accountId,
    principalType,
    principalId,
    scopeType,
    scopeId,
    roleId,
    effect,
    conditions,
    createdBy: userId,
  });

  await auditIam(c, {
    accountId,
    action: 'iam.policy.create',
    resourceType: 'iam_policy',
    resourceId: policy.policyId,
    after: snapshotPolicy(policy),
  });

  return c.json(
    {
      policy_id: policy.policyId,
      principal_type: policy.principalType,
      principal_id: policy.principalId,
      scope_type: policy.scopeType,
      scope_id: policy.scopeId,
      role_id: policy.roleId,
      effect: policy.effect,
      conditions: policy.conditions,
      created_at: policy.createdAt.toISOString(),
    },
    201,
  );
});

iamRouter.patch('/:accountId/iam/policies/:policyId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const policyId = c.req.param('policyId');
  // policy.create covers both create + modify; treating them as the same
  // capability is simpler and matches how Cloudflare scopes it. Add a
  // dedicated policy.update later if we ever need to split them.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_CREATE);

  const body = await readBody(c);

  const scopeType = body.scopeType ?? body.scope_type;
  if (!isResourceType(scopeType)) {
    return c.json({ error: 'scopeType must be a valid resource type' }, 400);
  }
  const rawScopeId = body.scopeId ?? body.scope_id;
  const scopeId: string | null =
    typeof rawScopeId === 'string' && rawScopeId.length > 0 ? rawScopeId : null;
  if (scopeType === 'account' && scopeId !== null) {
    return c.json({ error: 'scope_type=account requires scope_id to be null' }, 400);
  }
  if (scopeType !== 'account' && scopeId === null) {
    return c.json({ error: 'resource-specific scopes require a scope_id' }, 400);
  }
  const roleId = (body.roleId ?? body.role_id) as unknown;
  if (typeof roleId !== 'string' || !roleId) {
    return c.json({ error: 'roleId is required' }, 400);
  }
  const effectRaw = body.effect ?? 'allow';
  if (effectRaw !== 'allow' && effectRaw !== 'deny') {
    return c.json({ error: 'effect must be allow or deny' }, 400);
  }
  const effect = effectRaw as 'allow' | 'deny';

  // Conditions on PATCH: missing key → leave existing untouched; explicit
  // {} → clears any prior conditions. parseConditions handles the parse.
  const conditionsProvided = body.conditions !== undefined;
  const conditionsResult = parseConditions(body.conditions);
  if (!conditionsResult.ok) return c.json({ error: conditionsResult.error }, 400);
  const conditions = conditionsResult.value;

  const role = await getRoleById(accountId, roleId);
  if (!role) return c.json({ error: 'unknown role' }, 404);
  if (role.resourceType !== scopeType && role.resourceType !== 'account') {
    return c.json(
      {
        error: `role '${role.key}' is for ${role.resourceType} scope; cannot attach at ${scopeType} scope`,
      },
      400,
    );
  }

  // Capture the pre-state so the audit row carries a true before/after diff.
  // If the row doesn't exist we let updatePolicy below return null and 404.
  const beforePolicy = await getPolicyById(accountId, policyId);

  try {
    const updated = await updatePolicy(accountId, policyId, {
      scopeType,
      scopeId,
      roleId,
      effect,
      ...(conditionsProvided ? { conditions } : {}),
    });
    if (!updated) return c.json({ error: 'policy not found' }, 404);

    await auditIam(c, {
      accountId,
      action: 'iam.policy.update',
      resourceType: 'iam_policy',
      resourceId: policyId,
      before: beforePolicy ? snapshotPolicy(beforePolicy) : null,
      after: snapshotPolicy(updated),
    });

    return c.json({
      policy_id: updated.policyId,
      principal_type: updated.principalType,
      principal_id: updated.principalId,
      scope_type: updated.scopeType,
      scope_id: updated.scopeId,
      role_id: updated.roleId,
      effect: updated.effect,
      conditions: updated.conditions,
      created_at: updated.createdAt.toISOString(),
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return c.json(
        { error: 'A policy with these exact properties already exists.' },
        409,
      );
    }
    throw err;
  }
});

iamRouter.delete('/:accountId/iam/policies/:policyId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const policyId = c.req.param('policyId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_DELETE);

  // Snapshot pre-state — once deletePolicy returns we can't reconstruct it.
  const beforePolicy = await getPolicyById(accountId, policyId);

  const ok = await deletePolicy(accountId, policyId);
  if (!ok) return c.json({ error: 'policy not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.policy.delete',
    resourceType: 'iam_policy',
    resourceId: policyId,
    before: beforePolicy ? snapshotPolicy(beforePolicy) : null,
  });

  return c.json({ deleted: true });
});

// ─── Roles ─────────────────────────────────────────────────────────────────

iamRouter.get('/:accountId/iam/roles', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);

  const roles = await listRoles(accountId);
  return c.json({
    roles: roles.map((r) => ({
      role_id: r.roleId,
      key: r.key,
      name: r.name,
      description: r.description,
      resource_type: r.resourceType,
      is_system: r.isSystem,
      account_id: r.accountId,
    })),
  });
});

iamRouter.get('/:accountId/iam/roles/:roleId/permissions', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const roleId = c.req.param('roleId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);

  const role = await getRoleById(accountId, roleId);
  if (!role) return c.json({ error: 'role not found' }, 404);
  const actions = await getRolePermissions(roleId);
  return c.json({
    role_id: roleId,
    key: role.key,
    actions,
  });
});

// Catalog of every valid action the system understands, grouped by resource
// type for the Create/Edit role picker. Public to any reader of roles
// (everyone with role.read) — there's nothing sensitive about knowing which
// actions exist; we don't reveal who has them.
iamRouter.get('/:accountId/iam/actions', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);
  return c.json({
    actions: ACTION_CATALOG.map((e) => ({
      action: e.action,
      label: e.label,
      resource_type: e.resourceType,
    })),
  });
});

// Usage count — drives the "in use by N policies" warning on the role
// detail page so admins know before they try to delete a referenced role.
iamRouter.get('/:accountId/iam/roles/:roleId/usage', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const roleId = c.req.param('roleId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);

  const role = await getRoleById(accountId, roleId);
  if (!role) return c.json({ error: 'role not found' }, 404);
  const policyCount = await countPoliciesUsingRole(accountId, roleId);
  return c.json({ role_id: roleId, policy_count: policyCount });
});

// ─── Custom role mutations ────────────────────────────────────────────────
// System roles (account_id IS NULL) are immutable — they're seeded from
// code on every API boot, so mutations through this surface would be lost
// anyway. We block them with a clear 403 instead of letting the user spend
// minutes on a form before learning that.

const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

function validateRoleKey(raw: unknown): { ok: true; key: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'key is required' };
  const key = raw.trim();
  if (!ROLE_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      error:
        'key must start with a letter and contain only lowercase letters, digits, or underscores (max 64 chars)',
    };
  }
  return { ok: true, key };
}

function validateActionList(raw: unknown): { ok: true; actions: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'actions must be an array' };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of raw) {
    if (typeof a !== 'string') return { ok: false, error: 'each action must be a string' };
    if (!VALID_ACTIONS.has(a)) return { ok: false, error: `unknown action: ${a}` };
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return { ok: true, actions: out };
}

iamRouter.post('/:accountId/iam/roles', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_CREATE);

  const body = await readBody(c);

  const keyCheck = validateRoleKey(body.key);
  if (!keyCheck.ok) return c.json({ error: keyCheck.error }, 400);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 128) return c.json({ error: 'name too long (max 128)' }, 400);

  const description = typeof body.description === 'string' ? body.description : null;

  const resourceTypeRaw = body.resourceType ?? body.resource_type;
  if (!isResourceType(resourceTypeRaw)) {
    return c.json({ error: 'resourceType must be a valid resource type' }, 400);
  }

  const actionCheck = validateActionList(body.actions ?? []);
  if (!actionCheck.ok) return c.json({ error: actionCheck.error }, 400);
  if (actionCheck.actions.length === 0) {
    return c.json({ error: 'at least one action is required' }, 400);
  }

  try {
    const role = await createCustomRole({
      accountId,
      key: keyCheck.key,
      name,
      description,
      resourceType: resourceTypeRaw,
      actions: actionCheck.actions,
    });

    await auditIam(c, {
      accountId,
      action: 'iam.role.create',
      resourceType: 'iam_role',
      resourceId: role.roleId,
      after: {
        key: role.key,
        name: role.name,
        resource_type: role.resourceType,
        actions: actionCheck.actions,
      },
    });

    return c.json(
      {
        role_id: role.roleId,
        key: role.key,
        name: role.name,
        description: role.description,
        resource_type: role.resourceType,
        is_system: role.isSystem,
      },
      201,
    );
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A role with this key already exists in the account' }, 409);
    }
    throw err;
  }
});

iamRouter.patch('/:accountId/iam/roles/:roleId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const roleId = c.req.param('roleId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_UPDATE);

  // System role guard — getRoleById returns it if accountId IS NULL, so
  // check is_system explicitly and reject before any write attempt.
  const existing = await getRoleById(accountId, roleId);
  if (!existing) return c.json({ error: 'role not found' }, 404);
  if (existing.isSystem) {
    return c.json({ error: 'System roles cannot be edited' }, 403);
  }

  const body = await readBody(c);
  const patch: { name?: string; description?: string | null } = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name || name.length > 128) return c.json({ error: 'invalid name' }, 400);
    patch.name = name;
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' ? body.description : null;
  }

  const updated = await updateCustomRole(accountId, roleId, patch);
  if (!updated) return c.json({ error: 'role not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.role.update',
    resourceType: 'iam_role',
    resourceId: roleId,
    before: { name: existing.name, description: existing.description },
    after: { name: updated.name, description: updated.description },
  });

  return c.json({
    role_id: updated.roleId,
    key: updated.key,
    name: updated.name,
    description: updated.description,
    resource_type: updated.resourceType,
    is_system: updated.isSystem,
  });
});

iamRouter.put('/:accountId/iam/roles/:roleId/permissions', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const roleId = c.req.param('roleId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_UPDATE);

  const existing = await getRoleById(accountId, roleId);
  if (!existing) return c.json({ error: 'role not found' }, 404);
  if (existing.isSystem) {
    return c.json({ error: 'System role permissions cannot be edited' }, 403);
  }

  const body = await readBody(c);
  const actionCheck = validateActionList(body.actions ?? []);
  if (!actionCheck.ok) return c.json({ error: actionCheck.error }, 400);
  if (actionCheck.actions.length === 0) {
    return c.json({ error: 'a role must grant at least one action' }, 400);
  }

  const before = await getRolePermissions(roleId);
  const result = await replaceRolePermissions(accountId, roleId, actionCheck.actions);
  if (!result.updated) return c.json({ error: 'role not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.role.permissions.update',
    resourceType: 'iam_role',
    resourceId: roleId,
    before: { actions: before },
    after: { actions: actionCheck.actions, added: result.added, removed: result.removed },
  });

  return c.json({ role_id: roleId, actions: actionCheck.actions });
});

iamRouter.delete('/:accountId/iam/roles/:roleId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const roleId = c.req.param('roleId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_DELETE);

  const existing = await getRoleById(accountId, roleId);
  if (!existing) return c.json({ error: 'role not found' }, 404);
  if (existing.isSystem) {
    return c.json({ error: 'System roles cannot be deleted' }, 403);
  }

  // Friendly pre-flight: count policies referencing the role so we can
  // return a clear message instead of relying on a DB FK error.
  const usage = await countPoliciesUsingRole(accountId, roleId);
  if (usage > 0) {
    return c.json(
      {
        error: `Cannot delete: this role is attached to ${usage} ${usage === 1 ? 'policy' : 'policies'}. Remove those policies first.`,
        policy_count: usage,
      },
      409,
    );
  }

  try {
    const ok = await deleteCustomRole(accountId, roleId);
    if (!ok) return c.json({ error: 'role not found' }, 404);
  } catch (err: unknown) {
    // Race: a policy was created referencing this role between the count
    // and the delete. ON DELETE RESTRICT (FK code 23503) catches it.
    const cause = (err as { cause?: { code?: string } })?.cause;
    if (cause?.code === '23503') {
      return c.json(
        {
          error: 'Cannot delete: a policy was just created referencing this role.',
        },
        409,
      );
    }
    throw err;
  }

  await auditIam(c, {
    accountId,
    action: 'iam.role.delete',
    resourceType: 'iam_role',
    resourceId: roleId,
    before: {
      key: existing.key,
      name: existing.name,
      resource_type: existing.resourceType,
    },
  });

  return c.json({ deleted: true });
});

// ─── Super-admin promotion ─────────────────────────────────────────────────

iamRouter.patch('/:accountId/iam/members/:userId/super-admin', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);

  const body = await readBody(c);
  const isSuperAdmin = body.isSuperAdmin === true || body.is_super_admin === true;

  // Snapshot the prior flag so an audit reader can see "Alice already had
  // super-admin → no-op" vs "Alice was promoted on March 5". Cheap query
  // since the row is small and the update runs against the same key.
  const [before] = await db
    .select({ isSuperAdmin: accountMembers.isSuperAdmin })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)),
    )
    .limit(1);

  const [updated] = await db
    .update(accountMembers)
    .set({ isSuperAdmin })
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.userId, targetUserId),
      ),
    )
    .returning({ userId: accountMembers.userId, isSuperAdmin: accountMembers.isSuperAdmin });

  if (!updated) return c.json({ error: 'member not found' }, 404);

  await auditIam(c, {
    accountId,
    action: updated.isSuperAdmin
      ? 'iam.member.super_admin.grant'
      : 'iam.member.super_admin.revoke',
    resourceType: 'account_member',
    resourceId: targetUserId,
    before: { is_super_admin: before?.isSuperAdmin ?? false },
    after: { is_super_admin: updated.isSuperAdmin },
  });

  return c.json({
    user_id: updated.userId,
    is_super_admin: updated.isSuperAdmin,
  });
});

// ─── Member's group memberships ────────────────────────────────────────────
// Used by the member detail page so admins can see "this person inherits
// these policies via these groups".

iamRouter.get('/:accountId/iam/members/:userId/groups', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  // Users can always see their own group memberships; otherwise gate on
  // member.read (same rule as the effective-permission probe).
  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const rows = await listGroupsForMember(accountId, targetUserId);
  return c.json({
    groups: rows.map((r) => ({
      group_id: r.groupId,
      name: r.name,
      added_at: r.addedAt.toISOString(),
    })),
  });
});

// ─── Effective permissions probe ───────────────────────────────────────────
// The UI uses this to render "what can this user actually do".

iamRouter.get('/:accountId/iam/members/:userId/effective', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  // Anyone with member.read can probe anyone; users can always probe themselves.
  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const action = c.req.query('action');
  if (!action) {
    return c.json({ error: 'action query parameter is required' }, 400);
  }

  const scope = c.req.query('resourceType');
  const id = c.req.query('resourceId');

  let target: Parameters<typeof authorize>[3];
  if (scope && isResourceType(scope) && scope !== 'account') {
    if (!id) return c.json({ error: 'resourceId required when resourceType is specified' }, 400);
    target = { type: scope, id } as Parameters<typeof authorize>[3];
  } else {
    target = { type: 'account' };
  }

  const result = await authorize(targetUserId, accountId, action, target);
  return c.json({
    allowed: result.allowed,
    reason: result.reason ?? null,
    action,
    resource_type: resourceTypeForAction(action),
  });
});

// Batch variant. UIs that render N capability rows (the "what this member
// can do" panel, multi-button gating on a single screen) should call this
// instead of N separate /effective?action=... requests. Returns answers in
// the same order as the input; duplicates are NOT de-duped server-side so
// the caller can rely on indices matching.
const BATCH_MAX = 64;

iamRouter.post('/:accountId/iam/members/:userId/effective:batch', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const body = await readBody(c);
  const rawProbes = body.probes ?? body.queries;
  if (!Array.isArray(rawProbes)) {
    return c.json({ error: 'probes must be an array' }, 400);
  }
  if (rawProbes.length === 0) {
    return c.json({ results: [] });
  }
  if (rawProbes.length > BATCH_MAX) {
    return c.json(
      { error: `batch size must be ≤ ${BATCH_MAX} (got ${rawProbes.length})` },
      400,
    );
  }

  // Validate each probe BEFORE dispatching anything. Mixing valid and
  // invalid in the same batch is rejected entirely so the caller doesn't
  // get partial results that look successful at first glance.
  type ParsedProbe = {
    action: string;
    target: Parameters<typeof authorize>[3];
  };
  const parsed: ParsedProbe[] = [];
  for (let i = 0; i < rawProbes.length; i++) {
    const p = rawProbes[i];
    if (!p || typeof p !== 'object') {
      return c.json({ error: `probes[${i}] must be an object` }, 400);
    }
    const action = (p as { action?: unknown }).action;
    if (typeof action !== 'string' || !action) {
      return c.json({ error: `probes[${i}].action is required` }, 400);
    }
    const scope =
      (p as { resourceType?: unknown; resource_type?: unknown }).resourceType ??
      (p as { resource_type?: unknown }).resource_type;
    const id =
      (p as { resourceId?: unknown; resource_id?: unknown }).resourceId ??
      (p as { resource_id?: unknown }).resource_id;
    let target: Parameters<typeof authorize>[3];
    if (typeof scope === 'string' && isResourceType(scope) && scope !== 'account') {
      if (typeof id !== 'string' || !id) {
        return c.json(
          { error: `probes[${i}].resourceId required when resourceType is set` },
          400,
        );
      }
      target = { type: scope, id } as Parameters<typeof authorize>[3];
    } else if (scope !== undefined && scope !== 'account' && typeof scope === 'string') {
      // Caller passed something for resourceType but it's not a valid enum.
      return c.json(
        { error: `probes[${i}].resourceType is not a known resource type` },
        400,
      );
    } else {
      target = { type: 'account' };
    }
    parsed.push({ action, target });
  }

  // Dedupe in-flight calls but preserve output positions. This makes
  // duplicate (action,target) entries in the input free after the first.
  const cache = new Map<string, ReturnType<typeof authorize>>();
  const keyFor = (p: ParsedProbe) =>
    p.target?.type === 'account'
      ? `${p.action}|account|*`
      : `${p.action}|${p.target?.type}|${
          p.target && 'id' in p.target ? p.target.id : '*'
        }`;

  const results = await Promise.all(
    parsed.map(async (p) => {
      const key = keyFor(p);
      let inflight = cache.get(key);
      if (!inflight) {
        inflight = authorize(targetUserId, accountId, p.action, p.target);
        cache.set(key, inflight);
      }
      const r = await inflight;
      return {
        action: p.action,
        resource_type: resourceTypeForAction(p.action),
        resource_id: p.target && 'id' in p.target ? p.target.id : null,
        allowed: r.allowed,
        reason: r.reason ?? null,
      };
    }),
  );

  return c.json({ results });
});

// ─── Strict IAM mode (per-account flag) ───────────────────────────────────
// Flipping strict mode on instructs the engine to STOP falling back to the
// legacy account_role / project_members bridges. Only super-admin bypass
// and explicit IAM policies grant access.
//
// Safety: we refuse to flip ON if doing so would lock the account out
// (zero super-admins AND zero members with explicit Administrator policies).
// We also expose a preview endpoint that returns the members who would lose
// access RIGHT NOW so admins can stage policy changes before the flip.

iamRouter.get('/:accountId/iam/strict-mode', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({ iamStrictMode: accounts.iamStrictMode })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);
  return c.json({ enabled: row.iamStrictMode });
});

// Returns the impact preview: members who derive access SOLELY from
// legacy bridges (no explicit IAM policies, not super-admin) and would
// therefore lose all access the moment strict mode flips on. UI shows this
// above the confirm dialog.
iamRouter.get('/:accountId/iam/strict-mode/preview', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  // Pull every member of the account along with their flags.
  const members = await db
    .select({
      userId: accountMembers.userId,
      accountRole: accountMembers.accountRole,
      isSuperAdmin: accountMembers.isSuperAdmin,
    })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));

  // Users with at least one explicit IAM policy attached to them directly.
  // (Group-attached policies also keep access; included below.)
  const memberIds = members.map((m) => m.userId);
  const directPolicyRows = memberIds.length === 0
    ? []
    : await db
        .selectDistinct({ principalId: iamPolicies.principalId })
        .from(iamPolicies)
        .where(
          and(
            eq(iamPolicies.accountId, accountId),
            eq(iamPolicies.principalType, 'member'),
            inArray(iamPolicies.principalId, memberIds),
          ),
        );
  const directlyCovered = new Set(directPolicyRows.map((r) => r.principalId));

  // Users covered by any group policy = users in any group that has at
  // least one policy. Two-step lookup: groups-with-policies, then their
  // members.
  const groupsWithPolicies = await db
    .selectDistinct({ principalId: iamPolicies.principalId })
    .from(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        eq(iamPolicies.principalType, 'group'),
      ),
    );
  const groupIds = groupsWithPolicies.map((g) => g.principalId);
  const groupCovered = groupIds.length === 0
    ? new Set<string>()
    : new Set(
        (
          await db
            .select({ userId: accountGroupMembers.userId })
            .from(accountGroupMembers)
            .where(inArray(accountGroupMembers.groupId, groupIds))
        ).map((r) => r.userId),
      );

  // Members at risk: not super-admin AND no direct policy AND no group policy.
  // Project_members access doesn't count — those bridges go away too.
  const losers = members
    .filter(
      (m) =>
        !m.isSuperAdmin &&
        !directlyCovered.has(m.userId) &&
        !groupCovered.has(m.userId),
    )
    .map((m) => ({
      user_id: m.userId,
      account_role: m.accountRole,
    }));

  // Safety: is there at least one principal who will keep access?
  const willKeepAccess = members.some(
    (m) =>
      m.isSuperAdmin ||
      directlyCovered.has(m.userId) ||
      groupCovered.has(m.userId),
  );

  return c.json({
    losers,
    will_lock_out_account: !willKeepAccess,
  });
});

iamRouter.patch('/:accountId/iam/strict-mode', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  // Flipping strict mode is account-config-level — gate on account.write.
  // Tied to the same capability as renaming the account so we don't invent
  // a new role action that nobody has yet.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const enabled = body.enabled === true;

  const [before] = await db
    .select({ iamStrictMode: accounts.iamStrictMode })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);
  if (before.iamStrictMode === enabled) {
    return c.json({ enabled, unchanged: true });
  }

  // Lockout guard: if enabling, require at least one super-admin OR one
  // member/group with an explicit policy. We refuse rather than write a
  // state we can't undo through the same UI.
  if (enabled) {
    const [superAdmin] = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.isSuperAdmin, true)),
      )
      .limit(1);
    if (!superAdmin) {
      const [anyPolicy] = await db
        .select({ policyId: iamPolicies.policyId })
        .from(iamPolicies)
        .where(eq(iamPolicies.accountId, accountId))
        .limit(1);
      if (!anyPolicy) {
        return c.json(
          {
            error:
              'Cannot enable strict mode: no super-admins and no explicit policies exist. ' +
              'Promote a super-admin or create at least one policy first.',
          },
          409,
        );
      }
    }
  }

  await db
    .update(accounts)
    .set({ iamStrictMode: enabled, updatedAt: new Date() })
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: enabled ? 'iam.strict_mode.enable' : 'iam.strict_mode.disable',
    resourceType: 'account',
    resourceId: accountId,
    before: { iam_strict_mode: before.iamStrictMode },
    after: { iam_strict_mode: enabled },
  });

  return c.json({ enabled });
});

// ─── SCIM provisioning tokens ─────────────────────────────────────────────
// Bearer credentials configured in the customer's IdP (Okta, Azure AD, …)
// to drive /scim/v2/accounts/:accountId/*. Treated as account-admin-level
// secrets: only `account.write` can mint or revoke. Plaintext is returned
// exactly once at mint; everything else shows the public prefix only.

iamRouter.get('/:accountId/iam/scim/tokens', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const tokens = await listScimTokens(accountId);
  return c.json({
    tokens: tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      public_prefix: t.publicPrefix,
      status: t.status,
      created_at: t.createdAt.toISOString(),
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      expires_at: t.expiresAt?.toISOString() ?? null,
      revoked_at: t.revokedAt?.toISOString() ?? null,
    })),
  });
});

iamRouter.post('/:accountId/iam/scim/tokens', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 128) return c.json({ error: 'name too long (max 128 chars)' }, 400);

  const expiresAtRaw =
    typeof body.expires_at === 'string'
      ? body.expires_at
      : typeof body.expiresAt === 'string'
        ? body.expiresAt
        : null;
  let expiresAt: Date | undefined;
  if (expiresAtRaw) {
    const d = new Date(expiresAtRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json({ error: 'expires_at must be ISO-8601' }, 400);
    }
    if (d.getTime() <= Date.now()) {
      return c.json({ error: 'expires_at must be in the future' }, 400);
    }
    expiresAt = d;
  }

  const created = await createScimToken({
    accountId,
    name,
    createdBy: userId,
    expiresAt,
  });

  await auditIam(c, {
    accountId,
    action: 'iam.scim.token.create',
    resourceType: 'scim_token',
    resourceId: created.tokenId,
    after: {
      name: created.name,
      public_prefix: created.publicPrefix,
      expires_at: created.expiresAt?.toISOString() ?? null,
    },
  });

  // The secret is returned ONCE. Subsequent list calls only see the
  // public prefix. Audit never logs the secret.
  return c.json(
    {
      token_id: created.tokenId,
      name: created.name,
      secret: created.secret,
      public_prefix: created.publicPrefix,
      created_at: created.createdAt.toISOString(),
      expires_at: created.expiresAt?.toISOString() ?? null,
      scim_base_url: `/scim/v2/accounts/${accountId}`,
    },
    201,
  );
});

iamRouter.delete('/:accountId/iam/scim/tokens/:tokenId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const tokenId = c.req.param('tokenId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const ok = await revokeScimToken(accountId, tokenId);
  if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.scim.token.revoke',
    resourceType: 'scim_token',
    resourceId: tokenId,
  });

  return c.json({ revoked: true });
});

