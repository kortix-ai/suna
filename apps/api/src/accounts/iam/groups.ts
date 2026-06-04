// IAM V2 routes: account groups, group members, and group→project grants.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { and, asc, eq } from 'drizzle-orm';
import { projectGroupGrants, projects } from '@kortix/db';
import { db } from '../../shared/db';
import {
  ACCOUNT_ACTIONS,
  assertAuthorized,
} from '../../iam';
import {
  addGroupMembers,
  createGroup,
  deleteGroup,
  getGroup,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroup,
} from '../../repositories/iam';
import {
  iamRouter,
  AccountIdParam,
  GroupParams,
  GroupSchema,
  GroupMemberSchema,
  ProjectGrantSchema,
} from './app';
import { auditIam, isUniqueViolation, readBody } from './helpers';

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
