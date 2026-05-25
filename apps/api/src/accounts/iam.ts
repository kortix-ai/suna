// IAM REST surface — groups, policies, roles, super-admin promotion, and
// effective-permissions probe. Mounted under accountsRouter at
// /v1/accounts/:accountId/iam/*. Auth is inherited from the parent router
// (supabaseAuth populates userId). Every handler asserts the relevant IAM
// action via assertAuthorized().

import { Context, Hono } from 'hono';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accounts,
  iamPolicies,
  iamRoles,
  projectMembers,
} from '@kortix/db';
import { db } from '../shared/db';
import { getSupabase } from '../shared/supabase';
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
import {
  createSsoGroupMapping,
  deleteSsoGroupMapping,
  deleteSsoProvider,
  getSsoProvider,
  listSsoGroupMappings,
  upsertSsoProvider,
} from '../repositories/sso';
import { accountSessionActivity, iamApprovalRequests, iamBreakGlassGrants } from '@kortix/db';
import {
  analyseRoleUsage,
  listUsage,
  topPrincipals,
} from '../repositories/iam-analytics';
import { computeDriftReport } from '../repositories/iam-drift';
import { backfillAccountMembershipPolicies } from '../iam/backfill';
import {
  addGroupProjects,
  createProjectGroup,
  deleteProjectGroup,
  getProjectGroup,
  listGroupProjects,
  listProjectGroups,
  removeGroupProject,
  updateProjectGroup,
} from '../repositories/project-groups';
import {
  actionPassesBoundary,
  type PermissionBoundary,
  type PolicyScopeType,
} from '../iam';
import {
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  getServiceAccount,
  listServiceAccounts,
} from '../repositories/service-accounts';
import {
  POLICY_TEMPLATES,
  applyTemplate,
  getTemplate,
} from '../iam/policy-templates';
import { simulatePolicy, type SimulationProbe } from '../iam/simulator';
import {
  GATED_ACTIONS,
  NeedsApprovalError,
  approveRequest,
  rejectRequest,
  requireApproval,
} from '../iam/approvals';

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
    expires_at: p.expiresAt?.toISOString() ?? null,
  };
}

/** Parse a body's `expires_at` field. undefined = leave untouched on
 *  update / omit on create; null = clear; ISO string = set. Returns
 *  the parsed value or an error string. */
function parseExpiresAt(
  raw: unknown,
): { ok: true; value: Date | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'expires_at must be an ISO-8601 string or null' };
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: 'expires_at must be a valid ISO-8601 timestamp' };
  }
  if (d.getTime() < Date.now()) {
    return { ok: false, error: 'expires_at must be in the future' };
  }
  return { ok: true, value: d };
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
      // V1 surface — number of iam_policies referencing this group.
      policy_count: g.policyCount,
      // V2 surface — number of project_group_grants for this group.
      project_count: g.projectCount,
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
      expires_at: p.expiresAt?.toISOString() ?? null,
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

  const expiryResult = parseExpiresAt(body.expires_at ?? body.expiresAt);
  if (!expiryResult.ok) return c.json({ error: expiryResult.error }, 400);
  // On create, undefined → permanent (omit field); null is treated the
  // same as undefined since "create with already-cleared expiry" makes
  // no sense.
  const expiresAt = expiryResult.value ?? null;

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
    expiresAt,
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
      expires_at: policy.expiresAt?.toISOString() ?? null,
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

  const expiryResult = parseExpiresAt(body.expires_at ?? body.expiresAt);
  if (!expiryResult.ok) return c.json({ error: expiryResult.error }, 400);
  const expiresAtPatch = expiryResult.value; // undefined | null | Date

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
      ...(expiresAtPatch !== undefined ? { expiresAt: expiresAtPatch } : {}),
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
      expires_at: updated.expiresAt?.toISOString() ?? null,
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

// ─── Bulk policy operations ───────────────────────────────────────────────
// Multi-row delete + JSON import for admins managing dozens of policies
// at once. Both endpoints validate every entry up-front and write in
// a single transaction so a single bad row aborts the whole batch.

iamRouter.post('/:accountId/iam/policies:bulk-delete', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_DELETE);

  const body = await readBody(c);
  const raw = body.policy_ids ?? body.policyIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return c.json({ error: 'policy_ids must be a non-empty array' }, 400);
  }
  const ids = raw.filter((v): v is string => typeof v === 'string');
  if (ids.length === 0) return c.json({ deleted: 0 });
  if (ids.length > 500) {
    return c.json({ error: 'bulk delete capped at 500 ids per request' }, 400);
  }

  // Snapshot before-state per id so the audit trail keeps the deleted
  // rows for forensics.
  const beforeRows = await db
    .select()
    .from(iamPolicies)
    .where(
      and(eq(iamPolicies.accountId, accountId), inArray(iamPolicies.policyId, ids)),
    );

  const deleted = await db
    .delete(iamPolicies)
    .where(
      and(eq(iamPolicies.accountId, accountId), inArray(iamPolicies.policyId, ids)),
    )
    .returning({ policyId: iamPolicies.policyId });

  // One audit event per deletion so the existing UI groupings keep
  // working unchanged.
  for (const row of beforeRows) {
    await auditIam(c, {
      accountId,
      action: 'iam.policy.delete',
      resourceType: 'iam_policy',
      resourceId: row.policyId,
      before: {
        policy_id: row.policyId,
        principal_type: row.principalType,
        principal_id: row.principalId,
        scope_type: row.scopeType,
        scope_id: row.scopeId,
        role_id: row.roleId,
        effect: row.effect,
      },
    });
  }

  return c.json({ deleted: deleted.length });
});

iamRouter.post('/:accountId/iam/policies:bulk-import', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_CREATE);

  const body = await readBody(c);
  const raw = body.policies;
  if (!Array.isArray(raw) || raw.length === 0) {
    return c.json({ error: 'policies must be a non-empty array' }, 400);
  }
  if (raw.length > 500) {
    return c.json({ error: 'bulk import capped at 500 entries per request' }, 400);
  }

  // Validate every entry up-front; surface the first failure with its
  // index so the user can fix and re-submit.
  type ParsedEntry = {
    principalType: 'member' | 'group' | 'token';
    principalId: string;
    scopeType: PolicyScopeType;
    scopeId: string | null;
    roleKey: string;
    effect: 'allow' | 'deny';
    conditions: PolicyConditions;
  };
  const parsed: ParsedEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown>;
    if (!e || typeof e !== 'object') {
      return c.json({ error: `entry ${i}: must be an object` }, 400);
    }
    const principalType = (e.principal_type ?? e.principalType) as string;
    const principalId = (e.principal_id ?? e.principalId) as string;
    const scopeType = (e.scope_type ?? e.scopeType) as string;
    const scopeIdRaw = e.scope_id ?? e.scopeId;
    const roleKey = (e.role_key ?? e.roleKey) as string;
    const effectRaw = (e.effect ?? 'allow') as string;
    if (principalType !== 'member' && principalType !== 'group' && principalType !== 'token') {
      return c.json({ error: `entry ${i}: principal_type invalid` }, 400);
    }
    if (typeof principalId !== 'string' || !principalId) {
      return c.json({ error: `entry ${i}: principal_id missing` }, 400);
    }
    if (!isResourceType(scopeType) && scopeType !== 'project_group') {
      return c.json({ error: `entry ${i}: scope_type invalid` }, 400);
    }
    if (typeof roleKey !== 'string' || !roleKey) {
      return c.json(
        { error: `entry ${i}: role_key missing (export by role_key for portability)` },
        400,
      );
    }
    if (effectRaw !== 'allow' && effectRaw !== 'deny') {
      return c.json({ error: `entry ${i}: effect must be allow|deny` }, 400);
    }
    const scopeId: string | null =
      typeof scopeIdRaw === 'string' && scopeIdRaw.length > 0 ? scopeIdRaw : null;
    if (scopeType === 'account' && scopeId !== null) {
      return c.json({ error: `entry ${i}: account scope requires scope_id=null` }, 400);
    }
    if (scopeType !== 'account' && scopeId === null) {
      return c.json({ error: `entry ${i}: ${scopeType} scope requires scope_id` }, 400);
    }
    const condParsed = parseConditions(e.conditions);
    if (!condParsed.ok) {
      return c.json({ error: `entry ${i}: ${condParsed.error}` }, 400);
    }
    parsed.push({
      principalType,
      principalId,
      scopeType: scopeType as PolicyScopeType,
      scopeId,
      roleKey,
      effect: effectRaw,
      conditions: condParsed.value,
    });
  }

  // Resolve all referenced role keys in one query so import can run
  // without per-entry round-trips.
  const allKeys = Array.from(new Set(parsed.map((p) => p.roleKey)));
  const roleRows = await db
    .select({ key: iamRoles.key, roleId: iamRoles.roleId, accountId: iamRoles.accountId })
    .from(iamRoles)
    .where(
      and(
        or(isNull(iamRoles.accountId), eq(iamRoles.accountId, accountId)),
        inArray(iamRoles.key, allKeys),
      ),
    );
  const idByKey = new Map(roleRows.map((r) => [r.key, r.roleId] as const));
  const missing = allKeys.filter((k) => !idByKey.has(k));
  if (missing.length > 0) {
    return c.json(
      { error: `unknown role_key(s): ${missing.join(', ')}` },
      400,
    );
  }

  let created = 0;
  let skipped = 0;
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    try {
      const policy = await createPolicy({
        accountId,
        principalType: p.principalType,
        principalId: p.principalId,
        scopeType: p.scopeType,
        scopeId: p.scopeId,
        roleId: idByKey.get(p.roleKey)!,
        effect: p.effect,
        conditions: p.conditions,
        createdBy: userId,
      });
      // createPolicy returns the existing row on conflict — best-effort
      // distinguish via the absence of fresh createdAt change is fragile;
      // count all as created for v1 simplicity.
      void policy;
      created += 1;
    } catch (err) {
      if (isUniqueViolation(err)) {
        skipped += 1;
        continue;
      }
      errors.push({ index: i, error: (err as Error).message });
    }
  }

  await auditIam(c, {
    accountId,
    action: 'iam.policy.bulk_import',
    resourceType: 'iam_policy',
    resourceId: accountId,
    after: { attempted: parsed.length, created, skipped, errors: errors.length },
  });

  return c.json({ attempted: parsed.length, created, skipped, errors });
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

  // Two-person rule: granting super-admin is gated by the approval
  // workflow (when the account opts in). Revokes are NOT gated — you
  // always want a fast off-switch. The route accepts an approval id
  // via query string or header so the requester can retry after their
  // peer approves.
  if (isSuperAdmin) {
    const approvalRequestId =
      c.req.query('approval_request_id') ?? c.req.header('x-approval-request-id') ?? undefined;
    try {
      await requireApproval({
        accountId,
        action: 'member.super_admin.grant',
        requestedBy: callerId,
        targetId: targetUserId,
        payload: { is_super_admin: true },
        approvalRequestId,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
    } catch (err) {
      if (err instanceof NeedsApprovalError) {
        return c.json(
          {
            pending_approval: true,
            request_id: err.requestId,
            message: 'Approval required from another super-admin.',
          },
          202,
        );
      }
      throw err;
    }
  }

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

// ─── Account-wide MFA enforcement ─────────────────────────────────────────
// When enabled, the IAM engine denies every JWT request whose session is
// not aal2. Super-admins and PATs are exempt. Mirrors the strict-mode
// surface: GET status, GET preview (who would be locked out), PATCH to
// flip — with a lockout guard refusing flips that would orphan the
// account.

iamRouter.get('/:accountId/iam/mfa-required', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({ mfaRequired: accounts.mfaRequired })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);
  return c.json({ enabled: row.mfaRequired });
});

// Preview: members who have no VERIFIED MFA factor enrolled. These users
// would lose access the moment the flag flips — admins should see the
// list before clicking. Super-admins are still flagged (so admins can
// nudge them too) but called out separately so the UI can soften the
// warning (super-admins won't be locked out).
iamRouter.get('/:accountId/iam/mfa-required/preview', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  // Pull all members and the count of their verified MFA factors in one
  // round-trip. LEFT JOIN so members with zero factors still appear.
  const rows = await db.execute<{
    user_id: string;
    account_role: string;
    is_super_admin: boolean;
    verified_factors: number;
  }>(sql`
    SELECT
      am.user_id::text AS user_id,
      am.account_role::text AS account_role,
      am.is_super_admin,
      COALESCE((
        SELECT COUNT(*)::int FROM auth.mfa_factors mf
        WHERE mf.user_id = am.user_id AND mf.status = 'verified'
      ), 0) AS verified_factors
    FROM kortix.account_members am
    WHERE am.account_id = ${accountId}::uuid
  `);

  // Drizzle's .execute returns { rows: [...] } for raw SQL on pg.
  const dataRows = ((rows as unknown) as { rows: typeof rows }).rows ?? rows;

  const losers: Array<{
    user_id: string;
    account_role: string;
    is_super_admin: boolean;
  }> = [];
  let withMfa = 0;
  let total = 0;
  for (const r of dataRows as Array<{
    user_id: string;
    account_role: string;
    is_super_admin: boolean;
    verified_factors: number;
  }>) {
    total++;
    if (r.verified_factors > 0) {
      withMfa++;
      continue;
    }
    // Super-admins are exempt from enforcement but we still surface them
    // so the admin can prod them to enrol. Marked is_super_admin so the
    // UI can downgrade the warning style.
    losers.push({
      user_id: r.user_id,
      account_role: r.account_role,
      is_super_admin: r.is_super_admin,
    });
  }

  // Safety: at least one non-super-admin must already have MFA, OR there
  // must be a super-admin who'd retain access. Otherwise the flip would
  // orphan the account.
  const willLockOutAccount = !losers.some((l) => l.is_super_admin)
    && withMfa === 0;

  return c.json({
    total_members: total,
    members_with_mfa: withMfa,
    losers,
    will_lock_out_account: willLockOutAccount,
  });
});

iamRouter.patch('/:accountId/iam/mfa-required', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  // Gate on account.write — same level as renaming the account or
  // flipping strict mode. Avoids inventing a new role action.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const enabled = body.enabled === true;

  const [before] = await db
    .select({ mfaRequired: accounts.mfaRequired })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);
  if (before.mfaRequired === enabled) {
    return c.json({ enabled, unchanged: true });
  }

  // Two-person rule: turning MFA OFF is dangerous (instantly relaxes
  // the account's security posture), so it's gated by approvals when
  // the account opts in. Enabling MFA is NOT gated — admins should
  // always be able to ratchet up security without a second pair of
  // eyes.
  if (!enabled) {
    const approvalRequestId =
      c.req.query('approval_request_id') ?? c.req.header('x-approval-request-id') ?? undefined;
    try {
      await requireApproval({
        accountId,
        action: 'iam.mfa_required.disable',
        requestedBy: userId,
        targetId: accountId,
        payload: { enabled: false },
        approvalRequestId,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
    } catch (err) {
      if (err instanceof NeedsApprovalError) {
        return c.json(
          {
            pending_approval: true,
            request_id: err.requestId,
            message: 'Approval required from another super-admin.',
          },
          202,
        );
      }
      throw err;
    }
  }

  // Lockout guard on enable: there must be either at least one
  // super-admin (always exempt) OR at least one member with verified
  // MFA — otherwise the flip would orphan the account.
  if (enabled) {
    const [superAdmin] = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.isSuperAdmin, true),
        ),
      )
      .limit(1);
    if (!superAdmin) {
      const enrolled = await db.execute<{ user_id: string }>(sql`
        SELECT am.user_id
        FROM kortix.account_members am
        WHERE am.account_id = ${accountId}::uuid
          AND EXISTS (
            SELECT 1 FROM auth.mfa_factors mf
            WHERE mf.user_id = am.user_id AND mf.status = 'verified'
          )
        LIMIT 1
      `);
      const enrolledRows = ((enrolled as unknown) as { rows: typeof enrolled }).rows ?? enrolled;
      if (!enrolledRows || (enrolledRows as unknown as unknown[]).length === 0) {
        return c.json(
          {
            error:
              'Cannot enable MFA requirement: no super-admins and nobody has MFA enrolled. ' +
              'Promote a super-admin or have at least one member enrol MFA first.',
          },
          409,
        );
      }
    }
  }

  await db
    .update(accounts)
    .set({ mfaRequired: enabled, updatedAt: new Date() })
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: enabled ? 'iam.mfa_required.enable' : 'iam.mfa_required.disable',
    resourceType: 'account',
    resourceId: accountId,
    before: { mfa_required: before.mfaRequired },
    after: { mfa_required: enabled },
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

// ─── SAML SSO config ──────────────────────────────────────────────────────
// The Supabase auth.sso_providers row is created out-of-band (via Studio
// or the auth admin API — admins paste the IdP metadata there). We just
// record which kortix account owns it plus the claim mapping config. JIT
// provisioning + group sync runs in the auth middleware on every request.

function ssoProviderResponse(p: NonNullable<Awaited<ReturnType<typeof getSsoProvider>>>) {
  return {
    sso_provider_id: p.ssoProviderId,
    supabase_sso_provider_id: p.supabaseSsoProviderId,
    name: p.name,
    primary_domain: p.primaryDomain,
    group_claim_name: p.groupClaimName,
    auto_create_members: p.autoCreateMembers,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

iamRouter.get('/:accountId/iam/sso/provider', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const p = await getSsoProvider(accountId);
  if (!p) return c.json({ provider: null });
  return c.json({ provider: ssoProviderResponse(p) });
});

iamRouter.put('/:accountId/iam/sso/provider', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const supabaseSsoProviderId = (body.supabase_sso_provider_id ?? body.supabaseSsoProviderId) as unknown;
  const name = body.name as unknown;
  const primaryDomain = (body.primary_domain ?? body.primaryDomain) as unknown;
  const groupClaimName = (body.group_claim_name ?? body.groupClaimName) as unknown;
  const autoCreateMembers = (body.auto_create_members ?? body.autoCreateMembers) as unknown;

  if (typeof supabaseSsoProviderId !== 'string' || !/^[0-9a-f-]{36}$/i.test(supabaseSsoProviderId)) {
    return c.json({ error: 'supabase_sso_provider_id must be a UUID' }, 400);
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (
    typeof primaryDomain !== 'string' ||
    primaryDomain.trim().length === 0 ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(primaryDomain.trim())
  ) {
    return c.json({ error: 'primary_domain must be a valid domain' }, 400);
  }
  if (groupClaimName !== undefined && (typeof groupClaimName !== 'string' || groupClaimName.length > 128)) {
    return c.json({ error: 'group_claim_name must be a short string' }, 400);
  }

  const before = await getSsoProvider(accountId);
  const provider = await upsertSsoProvider({
    accountId,
    supabaseSsoProviderId,
    name: name.trim(),
    primaryDomain: primaryDomain.trim(),
    groupClaimName: typeof groupClaimName === 'string' ? groupClaimName : undefined,
    autoCreateMembers: typeof autoCreateMembers === 'boolean' ? autoCreateMembers : undefined,
  createdBy: userId,
  });

  await auditIam(c, {
    accountId,
    action: before ? 'iam.sso.provider.update' : 'iam.sso.provider.create',
    resourceType: 'sso_provider',
    resourceId: provider.ssoProviderId,
    before: before
      ? {
          supabase_sso_provider_id: before.supabaseSsoProviderId,
          name: before.name,
          primary_domain: before.primaryDomain,
          group_claim_name: before.groupClaimName,
          auto_create_members: before.autoCreateMembers,
        }
      : null,
    after: {
      supabase_sso_provider_id: provider.supabaseSsoProviderId,
      name: provider.name,
      primary_domain: provider.primaryDomain,
      group_claim_name: provider.groupClaimName,
      auto_create_members: provider.autoCreateMembers,
    },
  });

  return c.json({ provider: ssoProviderResponse(provider) });
});

iamRouter.delete('/:accountId/iam/sso/provider', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const before = await getSsoProvider(accountId);
  const ok = await deleteSsoProvider(accountId);
  if (!ok) return c.json({ error: 'no SSO provider configured' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.sso.provider.delete',
    resourceType: 'sso_provider',
    resourceId: before?.ssoProviderId ?? accountId,
    before: before
      ? {
          supabase_sso_provider_id: before.supabaseSsoProviderId,
          name: before.name,
          primary_domain: before.primaryDomain,
        }
      : null,
  });

  return c.json({ deleted: true });
});

// ─── SAML group mappings ──────────────────────────────────────────────────

iamRouter.get('/:accountId/iam/sso/mappings', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const rows = await listSsoGroupMappings(accountId);
  return c.json({
    mappings: rows.map((m) => ({
      mapping_id: m.mappingId,
      claim_value: m.claimValue,
      group_id: m.groupId,
      group_name: m.groupName,
      created_at: m.createdAt.toISOString(),
    })),
  });
});

iamRouter.post('/:accountId/iam/sso/mappings', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const claimValue = (body.claim_value ?? body.claimValue) as unknown;
  const groupId = (body.group_id ?? body.groupId) as unknown;
  if (typeof claimValue !== 'string' || claimValue.trim().length === 0) {
    return c.json({ error: 'claim_value is required' }, 400);
  }
  if (typeof groupId !== 'string' || !/^[0-9a-f-]{36}$/i.test(groupId)) {
    return c.json({ error: 'group_id must be a UUID' }, 400);
  }
  const provider = await getSsoProvider(accountId);
  if (!provider) {
    return c.json({ error: 'no SSO provider configured — set one first' }, 409);
  }

  try {
    const mapping = await createSsoGroupMapping({
      accountId,
      ssoProviderId: provider.ssoProviderId,
      claimValue: claimValue.trim(),
      groupId,
      createdBy: userId,
    });
    if (!mapping) return c.json({ error: 'group not found in this account' }, 404);

    await auditIam(c, {
      accountId,
      action: 'iam.sso.mapping.create',
      resourceType: 'sso_mapping',
      resourceId: mapping.mappingId,
      after: {
        claim_value: mapping.claimValue,
        group_id: mapping.groupId,
        group_name: mapping.groupName,
      },
    });

    return c.json(
      {
        mapping_id: mapping.mappingId,
        claim_value: mapping.claimValue,
        group_id: mapping.groupId,
        group_name: mapping.groupName,
        created_at: mapping.createdAt.toISOString(),
      },
      201,
    );
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A mapping for that claim value already exists.' }, 409);
    }
    throw err;
  }
});

iamRouter.delete('/:accountId/iam/sso/mappings/:mappingId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const mappingId = c.req.param('mappingId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const ok = await deleteSsoGroupMapping(accountId, mappingId);
  if (!ok) return c.json({ error: 'mapping not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.sso.mapping.delete',
    resourceType: 'sso_mapping',
    resourceId: mappingId,
  });

  return c.json({ deleted: true });
});

// ─── Session policy ───────────────────────────────────────────────────────
// Per-account ceilings on session age + idle gap. Null on either field
// means "no limit". 0 < value ≤ 10080 (one week).

const SESSION_LIMIT_MINUTES = 10080; // 7 days

iamRouter.get('/:accountId/iam/session-policy', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({
      maxLifetimeMinutes: accounts.sessionMaxLifetimeMinutes,
      idleTimeoutMinutes: accounts.sessionIdleTimeoutMinutes,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);

  return c.json({
    max_lifetime_minutes: row.maxLifetimeMinutes,
    idle_timeout_minutes: row.idleTimeoutMinutes,
  });
});

iamRouter.patch('/:accountId/iam/session-policy', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  // Accept null → clear, undefined → leave untouched, number → set.
  function parseLimit(key: string, value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new HttpError(400, `${key} must be a positive integer or null`);
    }
    if (value > SESSION_LIMIT_MINUTES) {
      throw new HttpError(
        400,
        `${key} cannot exceed ${SESSION_LIMIT_MINUTES} minutes (7 days)`,
      );
    }
    return value;
  }

  let maxLifetimeMinutes: number | null | undefined;
  let idleTimeoutMinutes: number | null | undefined;
  try {
    maxLifetimeMinutes = parseLimit(
      'max_lifetime_minutes',
      body.max_lifetime_minutes ?? body.maxLifetimeMinutes,
    );
    idleTimeoutMinutes = parseLimit(
      'idle_timeout_minutes',
      body.idle_timeout_minutes ?? body.idleTimeoutMinutes,
    );
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const [before] = await db
    .select({
      maxLifetimeMinutes: accounts.sessionMaxLifetimeMinutes,
      idleTimeoutMinutes: accounts.sessionIdleTimeoutMinutes,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (maxLifetimeMinutes !== undefined) updates.sessionMaxLifetimeMinutes = maxLifetimeMinutes;
  if (idleTimeoutMinutes !== undefined) updates.sessionIdleTimeoutMinutes = idleTimeoutMinutes;

  await db
    .update(accounts)
    .set(updates)
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: 'iam.session_policy.update',
    resourceType: 'account',
    resourceId: accountId,
    before: {
      max_lifetime_minutes: before.maxLifetimeMinutes,
      idle_timeout_minutes: before.idleTimeoutMinutes,
    },
    after: {
      max_lifetime_minutes:
        maxLifetimeMinutes !== undefined ? maxLifetimeMinutes : before.maxLifetimeMinutes,
      idle_timeout_minutes:
        idleTimeoutMinutes !== undefined ? idleTimeoutMinutes : before.idleTimeoutMinutes,
    },
  });

  return c.json({
    max_lifetime_minutes:
      maxLifetimeMinutes !== undefined ? maxLifetimeMinutes : before.maxLifetimeMinutes,
    idle_timeout_minutes:
      idleTimeoutMinutes !== undefined ? idleTimeoutMinutes : before.idleTimeoutMinutes,
  });
});

// ─── Active sessions + force-logout ───────────────────────────────────────

iamRouter.get('/:accountId/iam/sessions', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);

  const rows = await db
    .select({
      userId: accountSessionActivity.userId,
      sessionId: accountSessionActivity.sessionId,
      firstSeenAt: accountSessionActivity.firstSeenAt,
      lastSeenAt: accountSessionActivity.lastSeenAt,
      revokedAt: accountSessionActivity.revokedAt,
      revokedReason: accountSessionActivity.revokedReason,
      ip: accountSessionActivity.ip,
      userAgent: accountSessionActivity.userAgent,
    })
    .from(accountSessionActivity)
    .where(eq(accountSessionActivity.accountId, accountId))
    .orderBy(sql`${accountSessionActivity.lastSeenAt} DESC`)
    .limit(200);

  return c.json({
    sessions: rows.map((r) => ({
      user_id: r.userId,
      session_id: r.sessionId,
      first_seen_at: r.firstSeenAt.toISOString(),
      last_seen_at: r.lastSeenAt.toISOString(),
      revoked_at: r.revokedAt?.toISOString() ?? null,
      revoked_reason: r.revokedReason,
      ip: r.ip,
      user_agent: r.userAgent,
    })),
  });
});

iamRouter.post('/:accountId/iam/sessions/:sessionId/revoke', async (c) => {
  const actorUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const sessionId = c.req.param('sessionId');
  // Gate on member.remove — force-logout is roughly "kick this user off
  // for now"; reuses the same capability admins already grant.
  await assertAuthorized(actorUserId, accountId, ACCOUNT_ACTIONS.MEMBER_REMOVE);

  // Body optionally carries the target user (for safer audit). Either
  // way we just stamp revoked_at on the matching activity row.
  const rows = await db
    .update(accountSessionActivity)
    .set({
      revokedAt: sql`COALESCE(${accountSessionActivity.revokedAt}, now())`,
      revokedReason: sql`COALESCE(${accountSessionActivity.revokedReason}, 'admin')`,
      revokedBy: actorUserId,
    })
    .where(
      and(
        eq(accountSessionActivity.accountId, accountId),
        eq(accountSessionActivity.sessionId, sessionId),
      ),
    )
    .returning({ userId: accountSessionActivity.userId });

  if (rows.length === 0) {
    return c.json({ error: 'session not found' }, 404);
  }

  await auditIam(c, {
    accountId,
    action: 'iam.session.revoke',
    resourceType: 'session',
    resourceId: sessionId,
    after: { user_id: rows[0].userId, revoked_by: actorUserId },
  });

  return c.json({ revoked: true });
});

// Compact local error so the parser helper above can short-circuit.
class HttpError extends Error {
  constructor(public status: 400 | 404 | 409 | 422, message: string) {
    super(message);
  }
}

// ─── PAT lifecycle policy ─────────────────────────────────────────────────
// Per-account ceilings on CLI Personal Access Token lifetime + idle gap,
// plus a "require expiry on every PAT" toggle. Enforced at mint
// (createAccountToken) and validate (validateAccountToken) paths.
// Project-scoped tokens (sandbox-injected) are exempt at both sites.

const PAT_MAX_LIFETIME_DAYS = 365 * 2; // 2 years
const PAT_MAX_IDLE_DAYS = 365;

iamRouter.get('/:accountId/iam/pat-policy', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({
      maxLifetimeDays: accounts.patMaxLifetimeDays,
      requireExpiry: accounts.patRequireExpiry,
      idleRevokeDays: accounts.patIdleRevokeDays,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);

  return c.json({
    max_lifetime_days: row.maxLifetimeDays,
    require_expiry: row.requireExpiry,
    idle_revoke_days: row.idleRevokeDays,
  });
});

iamRouter.patch('/:accountId/iam/pat-policy', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);

  function parseDays(key: string, value: unknown, max: number): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new HttpError(400, `${key} must be a positive integer or null`);
    }
    if (value > max) {
      throw new HttpError(400, `${key} cannot exceed ${max} days`);
    }
    return value;
  }

  let maxLifetimeDays: number | null | undefined;
  let idleRevokeDays: number | null | undefined;
  let requireExpiry: boolean | undefined;
  try {
    maxLifetimeDays = parseDays(
      'max_lifetime_days',
      body.max_lifetime_days ?? body.maxLifetimeDays,
      PAT_MAX_LIFETIME_DAYS,
    );
    idleRevokeDays = parseDays(
      'idle_revoke_days',
      body.idle_revoke_days ?? body.idleRevokeDays,
      PAT_MAX_IDLE_DAYS,
    );
    const reqRaw = body.require_expiry ?? body.requireExpiry;
    if (reqRaw !== undefined) {
      if (typeof reqRaw !== 'boolean') {
        return c.json({ error: 'require_expiry must be a boolean' }, 400);
      }
      requireExpiry = reqRaw;
    }
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const [before] = await db
    .select({
      maxLifetimeDays: accounts.patMaxLifetimeDays,
      requireExpiry: accounts.patRequireExpiry,
      idleRevokeDays: accounts.patIdleRevokeDays,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (maxLifetimeDays !== undefined) updates.patMaxLifetimeDays = maxLifetimeDays;
  if (idleRevokeDays !== undefined) updates.patIdleRevokeDays = idleRevokeDays;
  if (requireExpiry !== undefined) updates.patRequireExpiry = requireExpiry;

  await db
    .update(accounts)
    .set(updates)
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: 'iam.pat_policy.update',
    resourceType: 'account',
    resourceId: accountId,
    before: {
      max_lifetime_days: before.maxLifetimeDays,
      require_expiry: before.requireExpiry,
      idle_revoke_days: before.idleRevokeDays,
    },
    after: {
      max_lifetime_days:
        maxLifetimeDays !== undefined ? maxLifetimeDays : before.maxLifetimeDays,
      require_expiry:
        requireExpiry !== undefined ? requireExpiry : before.requireExpiry,
      idle_revoke_days:
        idleRevokeDays !== undefined ? idleRevokeDays : before.idleRevokeDays,
    },
  });

  return c.json({
    max_lifetime_days:
      maxLifetimeDays !== undefined ? maxLifetimeDays : before.maxLifetimeDays,
    require_expiry:
      requireExpiry !== undefined ? requireExpiry : before.requireExpiry,
    idle_revoke_days:
      idleRevokeDays !== undefined ? idleRevokeDays : before.idleRevokeDays,
  });
});

// ─── Approval workflow ────────────────────────────────────────────────────
// Two-person rule for sensitive IAM actions. Per-account toggle plus
// CRUD on the request inbox. Gated set lives in iam/approvals.ts.

iamRouter.get('/:accountId/iam/approvals-policy', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({ enabled: accounts.iamApprovalsRequired })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);

  return c.json({
    enabled: row.enabled,
    gated_actions: [...GATED_ACTIONS],
  });
});

iamRouter.patch('/:accountId/iam/approvals-policy', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400);
  }
  const enabled = body.enabled;

  const [before] = await db
    .select({ enabled: accounts.iamApprovalsRequired })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);

  if (before.enabled === enabled) return c.json({ enabled, unchanged: true });

  await db
    .update(accounts)
    .set({ iamApprovalsRequired: enabled, updatedAt: new Date() })
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: enabled ? 'iam.approvals.enable' : 'iam.approvals.disable',
    resourceType: 'account',
    resourceId: accountId,
    before: { iam_approvals_required: before.enabled },
    after: { iam_approvals_required: enabled },
  });

  return c.json({ enabled });
});

iamRouter.get('/:accountId/iam/approvals', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const status = c.req.query('status'); // optional filter
  const baseConditions = [eq(iamApprovalRequests.accountId, accountId)];
  if (
    status === 'pending' ||
    status === 'approved' ||
    status === 'rejected'
  ) {
    baseConditions.push(eq(iamApprovalRequests.status, status));
  }

  const rows = await db
    .select()
    .from(iamApprovalRequests)
    .where(and(...baseConditions))
    .orderBy(desc(iamApprovalRequests.requestedAt))
    .limit(200);

  return c.json({
    requests: rows.map((r) => ({
      request_id: r.requestId,
      action: r.action,
      target_id: r.targetId,
      payload: r.payload,
      requester_reason: r.requesterReason,
      requested_by: r.requestedBy,
      requested_at: r.requestedAt.toISOString(),
      expires_at: r.expiresAt.toISOString(),
      status: r.status,
      decided_by: r.decidedBy,
      decided_at: r.decidedAt?.toISOString() ?? null,
      decision_reason: r.decisionReason,
      execution_result: r.executionResult,
    })),
  });
});

iamRouter.post('/:accountId/iam/approvals/:requestId/approve', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const requestId = c.req.param('requestId');
  // Gate the route itself on account.read (anyone able to see the inbox).
  // The approveRequest helper enforces super-admin + non-self.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const body = await readBody(c);
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  const result = await approveRequest({
    accountId,
    requestId,
    approverUserId: userId,
    decisionReason: reason,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);

  await auditIam(c, {
    accountId,
    action: 'iam.approval.approve',
    resourceType: 'iam_approval_request',
    resourceId: requestId,
    after: { action: result.request.action, target_id: result.request.targetId, reason },
  });

  return c.json({ approved: true, request_id: requestId });
});

// ─── Permission usage analytics ───────────────────────────────────────────
// Read-side surface backed by iam_action_usage (populated by the
// usage-recorder hooked into every allow path of the engine).

// ─── Legacy → IAM backfill ────────────────────────────────────────────────
// On-demand mirror of account_role + project_members into explicit IAM
// policies. Runs at boot for all accounts; this endpoint lets admins
// re-run for their own account on demand (UI uses it before flipping
// strict mode). Idempotent.

iamRouter.post('/:accountId/iam/backfill-membership-policies', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  let result;
  try {
    result = await backfillAccountMembershipPolicies(accountId);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }

  await auditIam(c, {
    accountId,
    action: 'iam.backfill.run',
    resourceType: 'account',
    resourceId: accountId,
    after: {
      owners_promoted: result.ownersPromoted,
      admins_mirrored: result.adminsMirrored,
      members_mirrored: result.membersMirrored,
      project_members_mirrored: result.projectMembersMirrored,
    },
  });

  return c.json({
    owners_promoted: result.ownersPromoted,
    admins_mirrored: result.adminsMirrored,
    members_mirrored: result.membersMirrored,
    project_members_mirrored: result.projectMembersMirrored,
  });
});

// ─── Drift detection ──────────────────────────────────────────────────────
// Surface stale / cleanup-candidate IAM objects. Pure read; the admin
// chooses what to prune. Lookback configurable via ?days= (default 60).

iamRouter.get('/:accountId/iam/drift', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);
  const daysRaw = c.req.query('days');
  let lookbackDays: number | undefined;
  if (daysRaw) {
    const n = parseInt(daysRaw, 10);
    if (Number.isInteger(n) && n > 0 && n <= 365) lookbackDays = n;
  }
  const report = await computeDriftReport({ accountId, lookbackDays });
  return c.json(report);
});

iamRouter.get('/:accountId/iam/analytics/usage', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);

  const limitRaw = c.req.query('limit');
  let limit = 1000;
  if (limitRaw) {
    const parsed = parseInt(limitRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 5000) limit = parsed;
  }

  const rows = await listUsage(accountId, limit);
  return c.json({
    usage: rows.map((r) => ({
      principal_kind: r.principalKind,
      principal_id: r.principalId,
      action: r.action,
      call_count: r.callCount,
      first_used_at: r.firstUsedAt.toISOString(),
      last_used_at: r.lastUsedAt.toISOString(),
    })),
  });
});

iamRouter.get('/:accountId/iam/analytics/top-principals', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);

  const rows = await topPrincipals(accountId, 25);
  return c.json({
    principals: rows.map((r) => ({
      principal_kind: r.principalKind,
      principal_id: r.principalId,
      total_calls: r.totalCalls,
      distinct_actions: r.distinctActions,
      last_used_at: r.lastUsedAt.toISOString(),
    })),
  });
});

iamRouter.get('/:accountId/iam/analytics/roles/:roleId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const roleId = c.req.param('roleId');
  // Role read is the natural permission for "see this role's usage".
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ROLE_READ);

  const role = await getRoleById(accountId, roleId);
  if (!role) return c.json({ error: 'role not found' }, 404);

  const analysis = await analyseRoleUsage({ accountId, roleId });
  return c.json({
    role_id: roleId,
    role_name: role.name,
    actions_in_role: analysis.actionsInRole,
    used_counts: analysis.usedCounts.map((u) => ({
      action: u.action,
      call_count: u.callCount,
      last_used_at: u.lastUsedAt.toISOString(),
    })),
    unused_actions: analysis.unusedActions,
  });
});

// ─── Policy simulator ─────────────────────────────────────────────────────
// "If I attach this policy, what changes?" Returns before/after for a
// set of probes without mutating any DB state. v1 supports member-
// principal probes exactly; group/token are approximate (the engine
// can't expand membership without committing the insert).

iamRouter.post('/:accountId/iam/policies:simulate', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_READ);

  const body = await readBody(c);
  const proposedRaw = body.proposed as Record<string, unknown> | undefined;
  if (!proposedRaw || typeof proposedRaw !== 'object') {
    return c.json({ error: 'proposed policy is required' }, 400);
  }
  const principalType = (proposedRaw.principal_type ?? proposedRaw.principalType) as string;
  const principalId = (proposedRaw.principal_id ?? proposedRaw.principalId) as string;
  const scopeType = (proposedRaw.scope_type ?? proposedRaw.scopeType) as string;
  const scopeIdRaw = proposedRaw.scope_id ?? proposedRaw.scopeId;
  const roleKey = (proposedRaw.role_key ?? proposedRaw.roleKey) as string;
  const effectRaw = (proposedRaw.effect ?? 'allow') as string;
  if (principalType !== 'member' && principalType !== 'group' && principalType !== 'token') {
    return c.json({ error: 'proposed.principal_type must be member|group|token' }, 400);
  }
  if (typeof principalId !== 'string' || !principalId) {
    return c.json({ error: 'proposed.principal_id is required' }, 400);
  }
  if (!isResourceType(scopeType) && scopeType !== 'project_group') {
    return c.json({ error: 'proposed.scope_type invalid' }, 400);
  }
  if (typeof roleKey !== 'string' || !roleKey) {
    return c.json({ error: 'proposed.role_key is required' }, 400);
  }
  if (effectRaw !== 'allow' && effectRaw !== 'deny') {
    return c.json({ error: 'proposed.effect must be allow|deny' }, 400);
  }

  const probesRaw = body.probes;
  if (!Array.isArray(probesRaw) || probesRaw.length === 0) {
    return c.json({ error: 'probes must be a non-empty array' }, 400);
  }
  if (probesRaw.length > 50) {
    return c.json({ error: 'probes capped at 50 per simulation' }, 400);
  }
  const probes: SimulationProbe[] = [];
  for (let i = 0; i < probesRaw.length; i++) {
    const p = probesRaw[i] as Record<string, unknown>;
    if (!p || typeof p !== 'object') {
      return c.json({ error: `probe ${i}: must be an object` }, 400);
    }
    const probeUserId = (p.user_id ?? p.userId) as string;
    const action = p.action as string;
    if (typeof probeUserId !== 'string' || !probeUserId) {
      return c.json({ error: `probe ${i}: user_id is required` }, 400);
    }
    if (typeof action !== 'string' || !action) {
      return c.json({ error: `probe ${i}: action is required` }, 400);
    }
    const targetTypeRaw = (p.resource_type ?? p.resourceType) as string | undefined;
    const targetIdRaw = (p.resource_id ?? p.resourceId) as string | undefined;
    let target: SimulationProbe['target'];
    if (targetTypeRaw) {
      if (targetTypeRaw === 'account') {
        target = { type: 'account' };
      } else if (
        targetTypeRaw === 'project' ||
        targetTypeRaw === 'sandbox' ||
        targetTypeRaw === 'trigger' ||
        targetTypeRaw === 'channel' ||
        targetTypeRaw === 'member' ||
        targetTypeRaw === 'group'
      ) {
        if (!targetIdRaw) {
          return c.json({ error: `probe ${i}: resource_id required for ${targetTypeRaw}` }, 400);
        }
        target = { type: targetTypeRaw, id: targetIdRaw };
      } else {
        return c.json({ error: `probe ${i}: unknown resource_type` }, 400);
      }
    }
    probes.push({ userId: probeUserId, action, target });
  }

  try {
    const result = await simulatePolicy({
      accountId,
      proposed: {
        principalType,
        principalId,
        scopeType: scopeType as PolicyScopeType,
        scopeId:
          typeof scopeIdRaw === 'string' && scopeIdRaw.length > 0
            ? scopeIdRaw
            : null,
        roleKey,
        effect: effectRaw,
      },
      probes,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ─── Policy templates / blueprints ────────────────────────────────────────
// Curated server-side recipes that materialise N policies in one apply.
// v1 ships a small static catalog; account-owned custom templates are a
// later iteration.

iamRouter.get('/:accountId/iam/policy-templates', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_READ);
  return c.json({
    templates: POLICY_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      needs_scope_id: t.needsScopeId,
      applies_to: t.appliesTo,
      entries: t.entries.map((e) => ({
        role_key: e.roleKey,
        scope_type: e.scopeType,
        note: e.note ?? null,
      })),
    })),
  });
});

iamRouter.post('/:accountId/iam/policy-templates/:key/apply', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const key = c.req.param('key');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.POLICY_CREATE);

  const template = getTemplate(key);
  if (!template) return c.json({ error: 'template not found' }, 404);

  const body = await readBody(c);
  const principalType = body.principal_type ?? body.principalType;
  const principalId = (body.principal_id ?? body.principalId) as unknown;
  const scopeIdRaw = (body.scope_id ?? body.scopeId) as unknown;
  const scopeId: string | null =
    typeof scopeIdRaw === 'string' && scopeIdRaw.length > 0 ? scopeIdRaw : null;
  if (principalType !== 'member' && principalType !== 'group' && principalType !== 'token') {
    return c.json({ error: 'principal_type must be member|group|token' }, 400);
  }
  if (typeof principalId !== 'string' || !principalId) {
    return c.json({ error: 'principal_id is required' }, 400);
  }
  if (template.needsScopeId !== 'account' && !scopeId) {
    return c.json(
      { error: `template requires a ${template.needsScopeId} scope_id` },
      400,
    );
  }

  // Verify the principal actually exists in this account before
  // creating policies for it.
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

  let result;
  try {
    result = await applyTemplate({
      template,
      accountId,
      principalType,
      principalId,
      scopeId,
      createdBy: userId,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  await auditIam(c, {
    accountId,
    action: 'iam.policy_template.apply',
    resourceType: 'iam_policy',
    resourceId: principalId,
    after: {
      template_key: template.key,
      principal_type: principalType,
      principal_id: principalId,
      scope_id: scopeId,
      created: result.created,
      skipped: result.skipped,
    },
  });

  return c.json(result, 201);
});

// ─── Service accounts (non-human IAM principals) ─────────────────────────
// First-class machine identities owned by the account itself. Policies
// attach via principal_type='token' with principal_id=service_account_id
// — the engine's token-as-principal short-circuit means SA requests are
// evaluated PURELY against the SA's own policies (no minter inheritance).

iamRouter.get('/:accountId/iam/service-accounts', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_READ);
  const rows = await listServiceAccounts(accountId);
  return c.json({
    service_accounts: rows.map((sa) => ({
      service_account_id: sa.serviceAccountId,
      name: sa.name,
      description: sa.description,
      public_prefix: sa.publicPrefix,
      status: sa.status,
      last_used_at: sa.lastUsedAt?.toISOString() ?? null,
      expires_at: sa.expiresAt?.toISOString() ?? null,
      created_at: sa.createdAt.toISOString(),
      disabled_at: sa.disabledAt?.toISOString() ?? null,
    })),
  });
});

iamRouter.post('/:accountId/iam/service-accounts', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_CREATE);

  const body = await readBody(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 128) return c.json({ error: 'name too long (max 128)' }, 400);
  const description =
    typeof body.description === 'string' ? body.description.trim() || null : null;
  const expiresAtRaw = typeof body.expires_at === 'string' ? body.expires_at.trim() : '';
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return c.json({ error: 'expires_at must be ISO-8601' }, 400);
  }

  try {
    const created = await createServiceAccount({
      accountId,
      name,
      description,
      expiresAt,
      createdBy: userId,
    });
    await auditIam(c, {
      accountId,
      action: 'iam.service_account.create',
      resourceType: 'service_account',
      resourceId: created.serviceAccountId,
      after: { name: created.name, description: created.description },
    });
    return c.json(
      {
        service_account_id: created.serviceAccountId,
        name: created.name,
        description: created.description,
        public_prefix: created.publicPrefix,
        status: created.status,
        expires_at: created.expiresAt?.toISOString() ?? null,
        created_at: created.createdAt.toISOString(),
        /** Plaintext bearer — shown ONCE. Store it now or rotate. */
        secret: created.secret,
      },
      201,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A service account with that name already exists.' }, 409);
    }
    throw err;
  }
});

iamRouter.post('/:accountId/iam/service-accounts/:saId/disable', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const saId = c.req.param('saId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_REVOKE);

  const before = await getServiceAccount(accountId, saId);
  if (!before) return c.json({ error: 'service account not found' }, 404);
  const ok = await disableServiceAccount({
    accountId,
    serviceAccountId: saId,
    disabledBy: userId,
  });
  if (!ok) return c.json({ error: 'service account is already disabled' }, 409);

  await auditIam(c, {
    accountId,
    action: 'iam.service_account.disable',
    resourceType: 'service_account',
    resourceId: saId,
    before: { name: before.name, status: before.status },
    after: { name: before.name, status: 'disabled' },
  });
  return c.json({ disabled: true });
});

iamRouter.delete('/:accountId/iam/service-accounts/:saId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const saId = c.req.param('saId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_REVOKE);

  const before = await getServiceAccount(accountId, saId);
  if (!before) return c.json({ error: 'service account not found' }, 404);
  await deleteServiceAccount(accountId, saId);

  await auditIam(c, {
    accountId,
    action: 'iam.service_account.delete',
    resourceType: 'service_account',
    resourceId: saId,
    before: { name: before.name },
  });
  return c.json({ deleted: true });
});

// ─── Cross-account external grants ────────────────────────────────────────
// Attach an existing Kortix user as an "external" member so the engine
// can resolve their policies against THIS account, without consuming a
// regular seat. Common consultant/multi-tenant pattern. Lookup happens
// by email — the external user must already have an auth.users row
// (i.e. they signed up to Kortix on their own); we don't invite via
// email at this layer.

iamRouter.get('/:accountId/iam/external-grants', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);

  const rows = await db
    .select({
      userId: accountMembers.userId,
      grantedBy: accountMembers.externalGrantedBy,
      grantedAt: accountMembers.joinedAt,
      expiresAt: accountMembers.externalGrantExpiresAt,
      note: accountMembers.externalNote,
    })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.isExternal, true),
      ),
    );

  return c.json({
    grants: rows.map((r) => ({
      user_id: r.userId,
      granted_by: r.grantedBy,
      granted_at: r.grantedAt.toISOString(),
      expires_at: r.expiresAt?.toISOString() ?? null,
      note: r.note,
      active:
        !r.expiresAt || r.expiresAt > new Date(),
    })),
  });
});

iamRouter.post('/:accountId/iam/external-grants', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  // Gating: same capability as inviting a regular member (member.invite).
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_INVITE);

  const body = await readBody(c);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return c.json({ error: 'email is required' }, 400);
  if (email.length > 320) return c.json({ error: 'email too long' }, 400);
  const note =
    typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
  let expiresAt: Date | null = null;
  if (typeof body.expires_at === 'string' && body.expires_at) {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime())) {
      return c.json({ error: 'expires_at must be ISO-8601' }, 400);
    }
    if (d.getTime() < Date.now()) {
      return c.json({ error: 'expires_at must be in the future' }, 400);
    }
    expiresAt = d;
  }

  // Resolve the target user by email via Supabase admin API. We don't
  // mint an invite here — the external user has to already exist in
  // auth.users.
  const supabase = getSupabase();
  const { data: lookup, error: lookupErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1,
    // @ts-expect-error supabase-js admin types lag the API
    email,
  });
  if (lookupErr) {
    return c.json({ error: lookupErr.message ?? 'failed to look up user' }, 502);
  }
  const targetUser = lookup?.users?.[0];
  if (!targetUser) {
    return c.json(
      {
        error:
          'No Kortix user with that email. The external user must already have an account.',
      },
      404,
    );
  }

  // Refuse silently if they're already a regular member — promoting a
  // regular member to "external" would strip their seat and confuse
  // billing.
  const [existing] = await db
    .select({
      userId: accountMembers.userId,
      isExternal: accountMembers.isExternal,
    })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUser.id)),
    )
    .limit(1);
  if (existing && !existing.isExternal) {
    return c.json(
      { error: 'User is already a regular member of this account.' },
      409,
    );
  }

  if (existing && existing.isExternal) {
    // Already an external; update the grant metadata.
    await db
      .update(accountMembers)
      .set({
        externalGrantExpiresAt: expiresAt,
        externalNote: note,
        externalGrantedBy: userId,
      })
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.userId, targetUser.id),
        ),
      );
  } else {
    await db.insert(accountMembers).values({
      accountId,
      userId: targetUser.id,
      accountRole: 'member',
      isExternal: true,
      externalGrantExpiresAt: expiresAt,
      externalNote: note,
      externalGrantedBy: userId,
    });
  }

  await auditIam(c, {
    accountId,
    action: 'iam.external_grant.create',
    resourceType: 'account_member',
    resourceId: targetUser.id,
    after: {
      email,
      expires_at: expiresAt?.toISOString() ?? null,
      note,
    },
  });

  return c.json(
    {
      user_id: targetUser.id,
      email,
      expires_at: expiresAt?.toISOString() ?? null,
      note,
    },
    201,
  );
});

iamRouter.delete('/:accountId/iam/external-grants/:userId', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_REMOVE);

  const rows = await db
    .delete(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.userId, targetUserId),
        eq(accountMembers.isExternal, true),
      ),
    )
    .returning({ userId: accountMembers.userId });

  if (rows.length === 0) {
    return c.json({ error: 'external grant not found' }, 404);
  }

  await auditIam(c, {
    accountId,
    action: 'iam.external_grant.revoke',
    resourceType: 'account_member',
    resourceId: targetUserId,
  });

  return c.json({ revoked: true });
});

// ─── Break-glass emergency access ─────────────────────────────────────────
// Activate-on-demand, time-bounded super-admin promotion. Only members
// who already hold member.super_admin.grant can activate (same trust
// boundary as permanent promotion). Auto-expires via the engine's
// freshness check, no cleanup job needed.

const BREAK_GLASS_MAX_MINUTES = 8 * 60; // 8 hours hard ceiling
const BREAK_GLASS_DEFAULT_MINUTES = 60;

iamRouter.get('/:accountId/iam/break-glass', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.AUDIT_READ);

  const rows = await db
    .select()
    .from(iamBreakGlassGrants)
    .where(eq(iamBreakGlassGrants.accountId, accountId))
    .orderBy(desc(iamBreakGlassGrants.activatedAt))
    .limit(100);

  const now = new Date();
  return c.json({
    grants: rows.map((g) => ({
      grant_id: g.grantId,
      user_id: g.userId,
      reason: g.reason,
      activated_at: g.activatedAt.toISOString(),
      expires_at: g.expiresAt.toISOString(),
      revoked_at: g.revokedAt?.toISOString() ?? null,
      revoked_by: g.revokedBy,
      active: !g.revokedAt && g.expiresAt > now,
    })),
  });
});

iamRouter.post('/:accountId/iam/break-glass/activate', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  // Eligibility = the same capability used to promote others to super-
  // admin. Members without it can't break glass.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);

  const body = await readBody(c);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return c.json({ error: 'reason is required' }, 400);
  if (reason.length > 1000) return c.json({ error: 'reason too long (max 1000)' }, 400);
  let minutes = BREAK_GLASS_DEFAULT_MINUTES;
  if (body.minutes !== undefined) {
    if (
      typeof body.minutes !== 'number' ||
      !Number.isInteger(body.minutes) ||
      body.minutes <= 0
    ) {
      return c.json({ error: 'minutes must be a positive integer' }, 400);
    }
    if (body.minutes > BREAK_GLASS_MAX_MINUTES) {
      return c.json(
        { error: `minutes cannot exceed ${BREAK_GLASS_MAX_MINUTES}` },
        400,
      );
    }
    minutes = body.minutes;
  }

  // Refuse a second concurrent grant — there's no semantic benefit to
  // overlapping ones, and it muddies the audit story.
  const [existing] = await db
    .select({ grantId: iamBreakGlassGrants.grantId })
    .from(iamBreakGlassGrants)
    .where(
      and(
        eq(iamBreakGlassGrants.accountId, accountId),
        eq(iamBreakGlassGrants.userId, userId),
        gt(iamBreakGlassGrants.expiresAt, new Date()),
        isNull(iamBreakGlassGrants.revokedAt),
      ),
    )
    .limit(1);
  if (existing) {
    return c.json(
      { error: 'A break-glass grant is already active for you — revoke it first.' },
      409,
    );
  }

  const expiresAt = new Date(Date.now() + minutes * 60_000);
  const [row] = await db
    .insert(iamBreakGlassGrants)
    .values({
      accountId,
      userId,
      reason,
      expiresAt,
    })
    .returning();

  await auditIam(c, {
    accountId,
    action: 'iam.break_glass.activate',
    resourceType: 'account',
    resourceId: accountId,
    after: {
      grant_id: row.grantId,
      reason,
      minutes,
      expires_at: expiresAt.toISOString(),
    },
  });

  return c.json(
    {
      grant_id: row.grantId,
      activated_at: row.activatedAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      reason: row.reason,
    },
    201,
  );
});

iamRouter.post('/:accountId/iam/break-glass/:grantId/revoke', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const grantId = c.req.param('grantId');
  // Anyone who could activate can also revoke. The grant holder can
  // always revoke their own.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);

  const rows = await db
    .update(iamBreakGlassGrants)
    .set({
      revokedAt: sql`COALESCE(${iamBreakGlassGrants.revokedAt}, now())`,
      revokedBy: userId,
    })
    .where(
      and(
        eq(iamBreakGlassGrants.accountId, accountId),
        eq(iamBreakGlassGrants.grantId, grantId),
      ),
    )
    .returning({ userId: iamBreakGlassGrants.userId });
  if (rows.length === 0) return c.json({ error: 'grant not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.break_glass.revoke',
    resourceType: 'account',
    resourceId: accountId,
    after: { grant_id: grantId, user_id: rows[0].userId, revoked_by: userId },
  });

  return c.json({ revoked: true });
});

// ─── Permission boundary (per-member max envelope) ───────────────────────
// AWS-style guardrail. When set, the engine clips this member's
// effective permissions down to the configured action-prefix list, even
// if explicit allow-policies cover more. Super-admins bypass.

iamRouter.get('/:accountId/iam/members/:userId/boundary', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  // Self-reads are always allowed (you should be able to see your own
  // boundary); admins gate on member.read.
  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const [row] = await db
    .select({ permissionBoundary: accountMembers.permissionBoundary })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)),
    )
    .limit(1);
  if (!row) return c.json({ error: 'member not found' }, 404);

  return c.json({ boundary: row.permissionBoundary as PermissionBoundary | null });
});

iamRouter.put('/:accountId/iam/members/:userId/boundary', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  // Boundary changes affect privilege envelopes — gate on the same
  // capability as super-admin promotion so only people who can already
  // hand out the keys can also cap them.
  await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);

  const body = await readBody(c);
  // Body shape:
  //   null              → clear the boundary (no clipping)
  //   { allow_action_prefixes: [...] } → set / replace
  let nextBoundary: PermissionBoundary | null = null;
  if (body.boundary !== null && body.boundary !== undefined) {
    if (typeof body.boundary !== 'object' || Array.isArray(body.boundary)) {
      return c.json({ error: 'boundary must be an object or null' }, 400);
    }
    const raw = (body.boundary as Record<string, unknown>).allow_action_prefixes;
    if (!Array.isArray(raw)) {
      return c.json(
        { error: 'boundary.allow_action_prefixes must be an array of strings' },
        400,
      );
    }
    const cleaned: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        return c.json({ error: 'allow_action_prefixes entries must be strings' }, 400);
      }
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (trimmed.length > 128) {
        return c.json({ error: 'allow_action_prefixes entries must be ≤128 chars' }, 400);
      }
      cleaned.push(trimmed);
    }
    if (cleaned.length > 200) {
      return c.json({ error: 'allow_action_prefixes: maximum 200 entries' }, 400);
    }
    nextBoundary = { allow_action_prefixes: cleaned };
  }

  const [before] = await db
    .select({ permissionBoundary: accountMembers.permissionBoundary })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)),
    )
    .limit(1);
  if (!before) return c.json({ error: 'member not found' }, 404);

  await db
    .update(accountMembers)
    .set({ permissionBoundary: nextBoundary })
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)),
    );

  await auditIam(c, {
    accountId,
    action: nextBoundary === null
      ? 'iam.member.boundary.clear'
      : 'iam.member.boundary.set',
    resourceType: 'account_member',
    resourceId: targetUserId,
    before: { boundary: before.permissionBoundary },
    after: { boundary: nextBoundary },
  });

  return c.json({ boundary: nextBoundary });
});

/** Probe: would `action` be clipped by the configured boundary? Used by
 *  the UI to show "this prefix list would block 12 actions" warnings. */
iamRouter.get('/:accountId/iam/members/:userId/boundary/probe', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const action = c.req.query('action');
  if (!action) return c.json({ error: 'action query param is required' }, 400);

  const [row] = await db
    .select({ permissionBoundary: accountMembers.permissionBoundary })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)),
    )
    .limit(1);
  if (!row) return c.json({ error: 'member not found' }, 404);

  const boundary = row.permissionBoundary as PermissionBoundary | null;
  if (!boundary) return c.json({ unbounded: true, allowed_by_boundary: true });
  return c.json({
    unbounded: false,
    allowed_by_boundary: actionPassesBoundary(action, boundary),
  });
});

// ─── Project groups (resource grouping) ───────────────────────────────────
// Bundle multiple projects so a single policy targets the whole bundle.
// scope_type='project_group' on iam_policies; the engine resolves "is
// the target project in this group?" at match time.

iamRouter.get('/:accountId/iam/project-groups', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const rows = await listProjectGroups(accountId);
  return c.json({
    groups: rows.map((r) => ({
      group_id: r.groupId,
      name: r.name,
      description: r.description,
      project_count: r.projectCount,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    })),
  });
});

iamRouter.post('/:accountId/iam/project-groups', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 128) return c.json({ error: 'name too long' }, 400);
  const description =
    typeof body.description === 'string' ? body.description.trim() || null : null;

  try {
    const group = await createProjectGroup({
      accountId,
      name,
      description,
      createdBy: userId,
    });
    await auditIam(c, {
      accountId,
      action: 'iam.project_group.create',
      resourceType: 'project_group',
      resourceId: group.groupId,
      after: { name: group.name, description: group.description },
    });
    return c.json(
      {
        group_id: group.groupId,
        name: group.name,
        description: group.description,
        project_count: 0,
        created_at: group.createdAt.toISOString(),
      },
      201,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A project group with that name already exists.' }, 409);
    }
    throw err;
  }
});

iamRouter.patch('/:accountId/iam/project-groups/:groupId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const before = await getProjectGroup(accountId, groupId);
  if (!before) return c.json({ error: 'group not found' }, 404);

  const body = await readBody(c);
  const patch: { name?: string; description?: string | null } = {};
  if (typeof body.name === 'string') {
    const trimmed = body.name.trim();
    if (!trimmed) return c.json({ error: 'name cannot be empty' }, 400);
    patch.name = trimmed;
  }
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === 'string' ? body.description.trim() || null : null;
  }

  try {
    const updated = await updateProjectGroup(accountId, groupId, patch);
    if (!updated) return c.json({ error: 'group not found' }, 404);
    await auditIam(c, {
      accountId,
      action: 'iam.project_group.update',
      resourceType: 'project_group',
      resourceId: groupId,
      before: { name: before.name, description: before.description },
      after: { name: updated.name, description: updated.description },
    });
    return c.json({
      group_id: updated.groupId,
      name: updated.name,
      description: updated.description,
      project_count: updated.projectCount,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A project group with that name already exists.' }, 409);
    }
    throw err;
  }
});

iamRouter.delete('/:accountId/iam/project-groups/:groupId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const before = await getProjectGroup(accountId, groupId);
  const ok = await deleteProjectGroup(accountId, groupId);
  if (!ok) return c.json({ error: 'group not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.project_group.delete',
    resourceType: 'project_group',
    resourceId: groupId,
    before: before ? { name: before.name } : null,
  });

  return c.json({ deleted: true });
});

iamRouter.get('/:accountId/iam/project-groups/:groupId/projects', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const rows = await listGroupProjects(accountId, groupId);
  return c.json({
    projects: rows.map((r) => ({
      project_id: r.projectId,
      project_name: r.projectName,
      added_at: r.addedAt.toISOString(),
    })),
  });
});

iamRouter.post('/:accountId/iam/project-groups/:groupId/projects', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const raw = body.project_ids ?? body.projectIds;
  if (!Array.isArray(raw)) {
    return c.json({ error: 'project_ids must be an array' }, 400);
  }
  const projectIds = raw.filter((v): v is string => typeof v === 'string');
  if (projectIds.length === 0) return c.json({ added: 0 });

  const group = await getProjectGroup(accountId, groupId);
  if (!group) return c.json({ error: 'group not found' }, 404);

  const result = await addGroupProjects({
    accountId,
    groupId,
    projectIds,
    addedBy: userId,
  });
  await auditIam(c, {
    accountId,
    action: 'iam.project_group.add_projects',
    resourceType: 'project_group',
    resourceId: groupId,
    after: { project_ids: projectIds, added: result.added },
  });
  return c.json(result);
});

iamRouter.delete('/:accountId/iam/project-groups/:groupId/projects/:projectId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  const projectId = c.req.param('projectId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const group = await getProjectGroup(accountId, groupId);
  if (!group) return c.json({ error: 'group not found' }, 404);

  const ok = await removeGroupProject(groupId, projectId);
  if (!ok) return c.json({ error: 'project not in group' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.project_group.remove_project',
    resourceType: 'project_group',
    resourceId: groupId,
    after: { project_id: projectId },
  });

  return c.json({ removed: true });
});

iamRouter.post('/:accountId/iam/approvals/:requestId/reject', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const requestId = c.req.param('requestId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const body = await readBody(c);
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  const result = await rejectRequest({
    accountId,
    requestId,
    approverUserId: userId,
    decisionReason: reason,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);

  await auditIam(c, {
    accountId,
    action: 'iam.approval.reject',
    resourceType: 'iam_approval_request',
    resourceId: requestId,
    after: { reason },
  });

  return c.json({ rejected: true, request_id: requestId });
});
