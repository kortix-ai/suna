// IAM REST surface — groups, policies, roles, super-admin promotion, and
// effective-permissions probe. Mounted under accountsRouter at
// /v1/accounts/:accountId/iam/*. Auth is inherited from the parent router
// (supabaseAuth populates userId). Every handler asserts the relevant IAM
// action via assertAuthorized().

import { Context, Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { accountMembers } from '@kortix/db';
import { db } from '../shared/db';
import type { AppEnv } from '../types';
import {
  ACCOUNT_ACTIONS,
  assertAuthorized,
  authorize,
  resourceTypeForAction,
  type ResourceType,
} from '../iam';
import {
  addGroupMembers,
  createGroup,
  createPolicy,
  deleteGroup,
  deletePolicy,
  getGroup,
  getRoleById,
  getRolePermissions,
  listGroupMembers,
  listGroups,
  listPolicies,
  listRoles,
  removeGroupMember,
  updateGroup,
  updatePolicy,
  type PolicyFilter,
} from '../repositories/iam';

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
    if (err instanceof Error && /unique/i.test(err.message)) {
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

  const updated = await updateGroup(accountId, groupId, patch);
  if (!updated) return c.json({ error: 'group not found' }, 404);
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

  const ok = await deleteGroup(accountId, groupId);
  if (!ok) return c.json({ error: 'group not found' }, 404);
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
    createdBy: userId,
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

  try {
    const updated = await updatePolicy(accountId, policyId, {
      scopeType,
      scopeId,
      roleId,
      effect,
    });
    if (!updated) return c.json({ error: 'policy not found' }, 404);
    return c.json({
      policy_id: updated.policyId,
      principal_type: updated.principalType,
      principal_id: updated.principalId,
      scope_type: updated.scopeType,
      scope_id: updated.scopeId,
      role_id: updated.roleId,
      effect: updated.effect,
      created_at: updated.createdAt.toISOString(),
    });
  } catch (err: unknown) {
    // Postgres unique violation when the new (principal, scope, role, effect)
    // already exists as a separate policy row.
    if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
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

  const ok = await deletePolicy(accountId, policyId);
  if (!ok) return c.json({ error: 'policy not found' }, 404);
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

// ─── Super-admin promotion ─────────────────────────────────────────────────

iamRouter.patch('/:accountId/iam/members/:userId/super-admin', async (c) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);

  const body = await readBody(c);
  const isSuperAdmin = body.isSuperAdmin === true || body.is_super_admin === true;

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
  return c.json({
    user_id: updated.userId,
    is_super_admin: updated.isSuperAdmin,
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
