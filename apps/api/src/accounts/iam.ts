// IAM V2 REST surface — groups, super-admin promotion, effective-permission
// probes, account-wide gates (MFA, sessions, PAT policy), and integrations
// (SCIM, SAML SSO, service accounts).
//
// V1 surfaces (policies, custom roles, permission boundary, strict mode,
// approvals, break-glass, external grants, project groups, drift,
// analytics, simulator, policy templates) were removed in PR5c when the
// V2 engine became the only authorization path. The V1 backend modules
// they relied on were removed in PR5d. The underlying iam_policies /
// iam_roles / iam_role_permissions / iam_break_glass_grants /
// iam_approval_requests / project_groups DB tables still exist but are
// no longer read from or written to — dropping them is a final
// destructive step gated on operator sign-off.
//
// Every handler asserts the relevant IAM action via assertAuthorized()
// from the engine entry-point in ../iam.

import { Context } from 'hono';
import { createRoute, z } from '@hono/zod-openapi';
import { makeOpenApiApp, json, errors, auth, ErrorSchema } from '../openapi';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accounts,
  projectGroupGrants,
  projectMembers,
  projects,
  accountSessionActivity,
} from '@kortix/db';
import { db } from '../shared/db';
import { getSupabase } from '../shared/supabase';
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
  deleteGroup,
  getGroup,
  listGroupMembers,
  listGroups,
  listGroupsForMember,
  removeGroupMember,
  updateGroup,
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
import {
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  getServiceAccount,
  listServiceAccounts,
} from '../repositories/service-accounts';

export const iamRouter = makeOpenApiApp<AppEnv>();

// ─── Reusable OpenAPI schemas ────────────────────────────────────────────────
// Permissive shapes: these power the docs, not runtime validation of responses.

const AccountIdParam = z.object({ accountId: z.string() });
const GroupParams = z.object({ accountId: z.string(), groupId: z.string() });
const MemberParams = z.object({ accountId: z.string(), userId: z.string() });

const GroupSchema = z
  .object({
    group_id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    source: z.string().optional(),
    external_id: z.string().nullable().optional(),
    member_count: z.number().optional(),
    project_count: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .openapi('IamGroup');

const GroupMemberSchema = z
  .object({
    user_id: z.string(),
    added_at: z.string(),
    added_by: z.string().nullable(),
  })
  .openapi('IamGroupMember');

const ProjectGrantSchema = z
  .object({
    project_id: z.string(),
    project_name: z.string(),
    role: z.string(),
    granted_by: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string().nullable(),
  })
  .openapi('IamProjectGrant');

const ProjectAccessSchema = z
  .object({
    project_id: z.string(),
    project_name: z.string(),
    role: z.string(),
    sources: z.array(z.string()),
  })
  .openapi('IamProjectAccess');

const EffectiveResultSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.string().nullable(),
    action: z.string(),
    resource_type: z.string().nullable().optional(),
  })
  .openapi('IamEffectiveResult');

const EffectiveBatchResultSchema = z
  .object({
    action: z.string(),
    resource_type: z.string().nullable().optional(),
    resource_id: z.string().nullable(),
    allowed: z.boolean(),
    reason: z.string().nullable(),
  })
  .openapi('IamEffectiveBatchResult');

const ScimTokenSchema = z
  .object({
    token_id: z.string(),
    name: z.string(),
    public_prefix: z.string(),
    status: z.string().optional(),
    secret: z.string().optional(),
    created_at: z.string(),
    last_used_at: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
    revoked_at: z.string().nullable().optional(),
    scim_base_url: z.string().optional(),
  })
  .openapi('IamScimToken');

const SsoProviderSchema = z
  .object({
    sso_provider_id: z.string(),
    supabase_sso_provider_id: z.string(),
    name: z.string(),
    primary_domain: z.string(),
    group_claim_name: z.string().nullable().optional(),
    auto_create_members: z.boolean().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('IamSsoProvider');

const SsoMappingSchema = z
  .object({
    mapping_id: z.string(),
    claim_value: z.string(),
    group_id: z.string(),
    group_name: z.string().nullable().optional(),
    created_at: z.string(),
  })
  .openapi('IamSsoMapping');

const ServiceAccountSchema = z
  .object({
    service_account_id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    public_prefix: z.string(),
    status: z.string().optional(),
    secret: z.string().optional(),
    last_used_at: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
    created_at: z.string(),
    disabled_at: z.string().nullable().optional(),
  })
  .openapi('IamServiceAccount');

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

/**
 * Audit helper bound to the request context. The global middleware already
 * logs a coarse "POST /v1/accounts/.../iam/groups" row for every state
 * change; these explicit calls add the before/after detail that makes "who
 * changed X for Y on Z date" a single audit_events query.
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

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/groups',
    tags: ['iam'],
    summary: 'List account groups',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ groups: z.array(GroupSchema) }), 'Groups in the account'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
      // Number of project_group_grants for this group.
      project_count: g.projectCount,
      created_at: g.createdAt.toISOString(),
      updated_at: g.updatedAt.toISOString(),
    })),
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/groups',
    tags: ['iam'],
    summary: 'Create an account group',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ name: z.string(), description: z.string().nullable().optional() }) } } } },
    responses: {
      201: json(GroupSchema, 'The created group'),
      ...errors(400, 401, 403, 409),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/groups/{groupId}',
    tags: ['iam'],
    summary: 'Get a group',
    ...auth,
    request: { params: GroupParams },
    responses: {
      200: json(GroupSchema, 'The group'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/groups/{groupId}',
    tags: ['iam'],
    summary: 'Update a group',
    ...auth,
    request: { params: GroupParams, body: { content: { 'application/json': { schema: z.object({ name: z.string(), description: z.string().nullable() }).partial() } } } },
    responses: {
      200: json(GroupSchema, 'The updated group'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/groups/{groupId}',
    tags: ['iam'],
    summary: 'Delete a group',
    ...auth,
    request: { params: GroupParams },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deletion result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

// ─── Group members ─────────────────────────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/groups/{groupId}/members',
    tags: ['iam'],
    summary: 'List group members',
    ...auth,
    request: { params: GroupParams },
    responses: {
      200: json(z.object({ members: z.array(GroupMemberSchema) }), 'Group members'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/groups/{groupId}/members',
    tags: ['iam'],
    summary: 'Add members to a group',
    ...auth,
    request: { params: GroupParams, body: { content: { 'application/json': { schema: z.object({ userIds: z.array(z.string()).optional(), userId: z.string().optional() }) } } } },
    responses: {
      200: json(z.object({ added: z.number() }), 'Number of members added'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/groups/{groupId}/members/{userId}',
    tags: ['iam'],
    summary: 'Remove a member from a group',
    ...auth,
    request: { params: z.object({ accountId: z.string(), groupId: z.string(), userId: z.string() }) },
    responses: {
      200: json(z.object({ removed: z.boolean() }), 'Removal result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

// ─── Group → project attachments (IAM V2) ──────────────────────────────────
//
// One read endpoint here so the group detail page can list every project
// the group is attached to (with role). Per-project CRUD lives under
// /v1/projects/:projectId/group-grants (already shipped) — those routes
// gate on project.members.manage and are the right place to detach a
// single grant. This endpoint just answers "which projects?" for the
// group view, gated by GROUP_READ.

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/groups/{groupId}/project-grants',
    tags: ['iam'],
    summary: 'List project grants for a group',
    ...auth,
    request: { params: GroupParams },
    responses: {
      200: json(z.object({ grants: z.array(ProjectGrantSchema) }), 'Project grants for the group'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.GROUP_READ);

  const group = await getGroup(accountId, groupId);
  if (!group) return c.json({ error: 'group not found' }, 404);

  const rows = await db
    .select({
      projectId: projectGroupGrants.projectId,
      projectName: projects.name,
      role: projectGroupGrants.role,
      grantedBy: projectGroupGrants.grantedBy,
      createdAt: projectGroupGrants.createdAt,
      expiresAt: projectGroupGrants.expiresAt,
    })
    .from(projectGroupGrants)
    .innerJoin(projects, eq(projects.projectId, projectGroupGrants.projectId))
    .where(
      and(
        eq(projectGroupGrants.groupId, groupId),
        eq(projectGroupGrants.accountId, accountId),
      ),
    )
    // Deterministic order so the row position doesn't visibly shift after
    // a role change. Without ORDER BY, Postgres can return rows in heap
    // order, which moves UPDATEd rows around. See twin query in
    // apps/api/src/projects/index.ts.
    .orderBy(asc(projectGroupGrants.createdAt), asc(projectGroupGrants.projectId));

  return c.json({
    grants: rows.map((r) => ({
      project_id: r.projectId,
      project_name: r.projectName,
      role: r.role,
      granted_by: r.grantedBy,
      created_at: r.createdAt.toISOString(),
      expires_at: r.expiresAt?.toISOString() ?? null,
    })),
  });
  },
);

// ─── Super-admin promotion ─────────────────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/members/{userId}/super-admin',
    tags: ['iam'],
    summary: 'Grant or revoke super-admin',
    ...auth,
    request: { params: MemberParams, body: { content: { 'application/json': { schema: z.object({ isSuperAdmin: z.boolean(), is_super_admin: z.boolean() }).partial() } } } },
    responses: {
      200: json(z.object({ user_id: z.string(), is_super_admin: z.boolean() }), 'Updated super-admin flag'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);

  const body = await readBody(c);
  // Accept camelCase or snake_case, but the field MUST be present and an
  // actual boolean. The previous `=== true` coercion meant a PATCH that
  // omitted the field (or sent a non-boolean) silently set
  // is_super_admin=false — i.e. a malformed/partial request could quietly
  // REVOKE super-admin. Reject those with a 400 instead of acting on them.
  const isSuperAdmin =
    typeof body.isSuperAdmin === 'boolean'
      ? body.isSuperAdmin
      : typeof body.is_super_admin === 'boolean'
        ? body.is_super_admin
        : undefined;
  if (isSuperAdmin === undefined) {
    return c.json({ error: 'isSuperAdmin (boolean) is required' }, 400);
  }

  // The V1 two-person approval gate (requireApproval / NeedsApprovalError)
  // was removed with the approvals workflow in PR5c. Super-admin grants
  // now apply immediately, gated only by the caller's own
  // member.super_admin.grant permission asserted above.

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
  },
);

// ─── Member's group memberships ────────────────────────────────────────────
// Used by the member detail page so admins can see "this person inherits
// these policies via these groups".

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/members/{userId}/groups',
    tags: ['iam'],
    summary: 'List group memberships for a member',
    ...auth,
    request: { params: MemberParams },
    responses: {
      200: json(z.object({ groups: z.array(GroupSchema) }), 'Groups the member belongs to'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

// V2-only: which projects does this member reach, and at what role?
// Combines three sources, max-role per project:
//   1. account_members.account_role of 'owner' or 'admin' → implicit
//      Manager on every active project in the account
//   2. direct project_members.project_role rows
//   3. project_group_grants for any group the user belongs to
// V1 callers can use the route too — the data is real either way — but
// the V1 UI doesn't surface it (PoliciesTable is the equivalent V1 view).
iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/members/{userId}/project-access',
    tags: ['iam'],
    summary: 'List effective project access for a member',
    ...auth,
    request: { params: MemberParams },
    responses: {
      200: json(z.object({ projects: z.array(ProjectAccessSchema) }), 'Projects the member can reach'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  type Role = 'manager' | 'editor' | 'viewer';
  const rank: Record<Role, number> = { viewer: 1, editor: 2, manager: 3 };
  const max = (a: Role, b: Role): Role => (rank[a] >= rank[b] ? a : b);

  // Project info we'll need for every row in the response.
  const allProjects = await db
    .select({
      projectId: projects.projectId,
      name: projects.name,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.accountId, accountId));
  const projectMeta = new Map(allProjects.map((p) => [p.projectId, p] as const));

  // 1) implicit manager via account_role
  const [membership] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!membership) {
    return c.json({ projects: [] });
  }

  const byProject = new Map<
    string,
    { role: Role; sources: ('implicit' | 'direct' | 'group')[] }
  >();
  if (membership.accountRole === 'owner' || membership.accountRole === 'admin') {
    for (const p of allProjects) {
      if (p.status !== 'active') continue;
      byProject.set(p.projectId, { role: 'manager', sources: ['implicit'] });
    }
  }

  // 2) direct project_members rows
  const directRows = await db
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.projectRole,
    })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.accountId, accountId),
        eq(projectMembers.userId, targetUserId),
      ),
    );
  for (const r of directRows) {
    const role = r.role as Role;
    const cur = byProject.get(r.projectId);
    if (cur) {
      cur.role = max(cur.role, role);
      if (!cur.sources.includes('direct')) cur.sources.push('direct');
    } else {
      byProject.set(r.projectId, { role, sources: ['direct'] });
    }
  }

  // 3) group grants for any group this user belongs to
  const groupMembershipRows = await db
    .select({ groupId: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, targetUserId));
  const groupIds = groupMembershipRows.map((g) => g.groupId);
  if (groupIds.length > 0) {
    const grantRows = await db
      .select({
        projectId: projectGroupGrants.projectId,
        role: projectGroupGrants.role,
      })
      .from(projectGroupGrants)
      .where(
        and(
          eq(projectGroupGrants.accountId, accountId),
          inArray(projectGroupGrants.groupId, groupIds),
        ),
      );
    for (const r of grantRows) {
      const role = r.role as Role;
      const cur = byProject.get(r.projectId);
      if (cur) {
        cur.role = max(cur.role, role);
        if (!cur.sources.includes('group')) cur.sources.push('group');
      } else {
        byProject.set(r.projectId, { role, sources: ['group'] });
      }
    }
  }

  const out: Array<{
    project_id: string;
    project_name: string;
    role: Role;
    sources: ('implicit' | 'direct' | 'group')[];
  }> = [];
  for (const [projectId, info] of byProject) {
    const meta = projectMeta.get(projectId);
    if (!meta || meta.status !== 'active') continue;
    out.push({
      project_id: projectId,
      project_name: meta.name,
      role: info.role,
      sources: info.sources,
    });
  }
  out.sort((a, b) => a.project_name.localeCompare(b.project_name));
  return c.json({ projects: out });
  },
);

// ─── Effective permissions probe ───────────────────────────────────────────
// The UI uses this to render "what can this user actually do".

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/members/{userId}/effective',
    tags: ['iam'],
    summary: 'Probe effective permission for a member',
    ...auth,
    request: { params: MemberParams, query: z.object({ action: z.string(), resourceType: z.string(), resourceId: z.string() }).partial() },
    responses: {
      200: json(EffectiveResultSchema, 'Effective-permission result'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

// Batch variant. UIs that render N capability rows (the "what this member
// can do" panel, multi-button gating on a single screen) should call this
// instead of N separate /effective?action=... requests. Returns answers in
// the same order as the input; duplicates are NOT de-duped server-side so
// the caller can rely on indices matching.
const BATCH_MAX = 64;

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/members/{userId}/effective:batch',
    tags: ['iam'],
    summary: 'Batch-probe effective permissions for a member',
    ...auth,
    request: { params: MemberParams, body: { content: { 'application/json': { schema: z.object({ probes: z.array(z.record(z.string(), z.any())).optional(), queries: z.array(z.record(z.string(), z.any())).optional() }) } } } },
    responses: {
      200: json(z.object({ results: z.array(EffectiveBatchResultSchema) }), 'Batch effective-permission results'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

// ─── Account-wide MFA enforcement ─────────────────────────────────────────
// When enabled, the IAM engine denies every JWT request whose session is
// not aal2. Super-admins and PATs are exempt. Mirrors the strict-mode
// surface: GET status, GET preview (who would be locked out), PATCH to
// flip — with a lockout guard refusing flips that would orphan the
// account.

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/mfa-required',
    tags: ['iam'],
    summary: 'Get account MFA-required status',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ enabled: z.boolean() }), 'MFA-required status'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

// Preview: members who have no VERIFIED MFA factor enrolled. These users
// would lose access the moment the flag flips — admins should see the
// list before clicking. Super-admins are still flagged (so admins can
// nudge them too) but called out separately so the UI can soften the
// warning (super-admins won't be locked out).
iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/mfa-required/preview',
    tags: ['iam'],
    summary: 'Preview who would be locked out by MFA enforcement',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ total_members: z.number(), members_with_mfa: z.number(), losers: z.array(z.object({ user_id: z.string(), account_role: z.string(), is_super_admin: z.boolean() })), will_lock_out_account: z.boolean() }), 'MFA enforcement preview'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/mfa-required',
    tags: ['iam'],
    summary: 'Enable or disable account MFA requirement',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } } },
    responses: {
      200: json(z.object({ enabled: z.boolean(), unchanged: z.boolean().optional() }), 'Updated MFA-required status'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
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
  // V1 approval-gate on MFA disable was removed in PR5c with the rest
  // of the approvals workflow. Disable now applies immediately, gated
  // only by the caller's own account.write permission asserted above.

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
  },
);

// ─── SCIM provisioning tokens ─────────────────────────────────────────────
// Bearer credentials configured in the customer's IdP (Okta, Azure AD, …)
// to drive /scim/v2/accounts/:accountId/*. Treated as account-admin-level
// secrets: only `account.write` can mint or revoke. Plaintext is returned
// exactly once at mint; everything else shows the public prefix only.

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/scim/tokens',
    tags: ['iam'],
    summary: 'List SCIM provisioning tokens',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ tokens: z.array(ScimTokenSchema) }), 'SCIM tokens'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/scim/tokens',
    tags: ['iam'],
    summary: 'Mint a SCIM provisioning token',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ name: z.string(), expires_at: z.string().optional(), expiresAt: z.string().optional() }) } } } },
    responses: {
      201: json(ScimTokenSchema, 'The minted SCIM token (secret shown once)'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/scim/tokens/{tokenId}',
    tags: ['iam'],
    summary: 'Revoke a SCIM provisioning token',
    ...auth,
    request: { params: z.object({ accountId: z.string(), tokenId: z.string() }) },
    responses: {
      200: json(z.object({ revoked: z.boolean() }), 'Revocation result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

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

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/sso/provider',
    tags: ['iam'],
    summary: 'Get the account SSO provider',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ provider: SsoProviderSchema.nullable() }), 'The SSO provider, or null'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const p = await getSsoProvider(accountId);
  if (!p) return c.json({ provider: null });
  return c.json({ provider: ssoProviderResponse(p) });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/iam/sso/provider',
    tags: ['iam'],
    summary: 'Create or update the SSO provider',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ supabase_sso_provider_id: z.string().optional(), supabaseSsoProviderId: z.string().optional(), name: z.string().optional(), primary_domain: z.string().optional(), primaryDomain: z.string().optional(), group_claim_name: z.string().optional(), groupClaimName: z.string().optional(), auto_create_members: z.boolean().optional(), autoCreateMembers: z.boolean().optional() }) } } } },
    responses: {
      200: json(z.object({ provider: SsoProviderSchema }), 'The upserted SSO provider'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/sso/provider',
    tags: ['iam'],
    summary: 'Delete the SSO provider',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deletion result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

// ─── SAML group mappings ──────────────────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/sso/mappings',
    tags: ['iam'],
    summary: 'List SSO group mappings',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ mappings: z.array(SsoMappingSchema) }), 'SSO group mappings'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/sso/mappings',
    tags: ['iam'],
    summary: 'Create an SSO group mapping',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ claim_value: z.string().optional(), claimValue: z.string().optional(), group_id: z.string().optional(), groupId: z.string().optional() }) } } } },
    responses: {
      201: json(SsoMappingSchema, 'The created mapping'),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/sso/mappings/{mappingId}',
    tags: ['iam'],
    summary: 'Delete an SSO group mapping',
    ...auth,
    request: { params: z.object({ accountId: z.string(), mappingId: z.string() }) },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deletion result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

// ─── Session policy ───────────────────────────────────────────────────────
// Per-account ceilings on session age + idle gap. Null on either field
// means "no limit". 0 < value ≤ 10080 (one week).

const SESSION_LIMIT_MINUTES = 10080; // 7 days

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/session-policy',
    tags: ['iam'],
    summary: 'Get the account session policy',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ max_lifetime_minutes: z.number().nullable(), idle_timeout_minutes: z.number().nullable() }), 'Session policy'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/session-policy',
    tags: ['iam'],
    summary: 'Update the account session policy',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ max_lifetime_minutes: z.number().nullable(), maxLifetimeMinutes: z.number().nullable(), idle_timeout_minutes: z.number().nullable(), idleTimeoutMinutes: z.number().nullable() }).partial() } } } },
    responses: {
      200: json(z.object({ max_lifetime_minutes: z.number().nullable(), idle_timeout_minutes: z.number().nullable() }), 'Updated session policy'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

// ─── Active sessions + force-logout ───────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/sessions',
    tags: ['iam'],
    summary: 'List recent account sessions',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ sessions: z.array(z.object({ user_id: z.string(), session_id: z.string(), first_seen_at: z.string(), last_seen_at: z.string(), revoked_at: z.string().nullable(), revoked_reason: z.string().nullable(), ip: z.string().nullable(), user_agent: z.string().nullable() })) }), 'Recent sessions'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/sessions/{sessionId}/revoke',
    tags: ['iam'],
    summary: 'Revoke (force-logout) a session',
    ...auth,
    request: { params: z.object({ accountId: z.string(), sessionId: z.string() }), body: { content: { 'application/json': { schema: z.object({}).partial() } } } },
    responses: {
      200: json(z.object({ revoked: z.boolean() }), 'Revocation result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

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

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/pat-policy',
    tags: ['iam'],
    summary: 'Get the account PAT policy',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ max_lifetime_days: z.number().nullable(), require_expiry: z.boolean(), idle_revoke_days: z.number().nullable() }), 'PAT policy'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/pat-policy',
    tags: ['iam'],
    summary: 'Update the account PAT policy',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ max_lifetime_days: z.number().nullable(), maxLifetimeDays: z.number().nullable(), idle_revoke_days: z.number().nullable(), idleRevokeDays: z.number().nullable(), require_expiry: z.boolean(), requireExpiry: z.boolean() }).partial() } } } },
    responses: {
      200: json(z.object({ max_lifetime_days: z.number().nullable(), require_expiry: z.boolean(), idle_revoke_days: z.number().nullable() }), 'Updated PAT policy'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);

// ─── Service accounts (non-human IAM principals) ─────────────────────────
// First-class machine identities owned by the account itself. Policies
// attach via principal_type='token' with principal_id=service_account_id
// — the engine's token-as-principal short-circuit means SA requests are
// evaluated PURELY against the SA's own policies (no minter inheritance).

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/service-accounts',
    tags: ['iam'],
    summary: 'List service accounts',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ service_accounts: z.array(ServiceAccountSchema) }), 'Service accounts'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/service-accounts',
    tags: ['iam'],
    summary: 'Create a service account',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ name: z.string(), description: z.string().optional(), expires_at: z.string().optional() }) } } } },
    responses: {
      201: json(ServiceAccountSchema, 'The created service account (secret shown once)'),
      ...errors(400, 401, 403, 409),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/service-accounts/{saId}/disable',
    tags: ['iam'],
    summary: 'Disable a service account',
    ...auth,
    request: { params: z.object({ accountId: z.string(), saId: z.string() }) },
    responses: {
      200: json(z.object({ disabled: z.boolean() }), 'Disable result'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
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
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/service-accounts/{saId}',
    tags: ['iam'],
    summary: 'Delete a service account',
    ...auth,
    request: { params: z.object({ accountId: z.string(), saId: z.string() }) },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deletion result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
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
  },
);
