/**
 * Session groups (`session_groups` flag): a project's shared folders of
 * sessions (`lib/session-groups.ts`). Every route answers 403
 * `feature_disabled` while the flag is off, after the project gate.
 *
 * Reading the groups needs what reading the session list needs: `read`
 * project access and `project.session.read`. Creating, renaming, reordering
 * and deleting a group, and filing a session, need `session` access, like a
 * session's labels: any member who works in the project organizes it for
 * everyone. A session is filed only by someone who may see it; to anyone else
 * it is 404.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  OkResponseSchema,
  SessionGroupAssignInputSchema,
  SessionGroupAssignmentSchema,
  SessionGroupCreateInputSchema,
  SessionGroupListSchema,
  SessionGroupOrderInputSchema,
  SessionGroupSchema,
  SessionGroupUpdateInputSchema,
  type SessionGroup,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { isUuid } from '../../shared/validate';
import type { AppEnv } from '../../types';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { guardSession } from '../lib/http-session-access';
import {
  createSessionGroup,
  deleteSessionGroup,
  listSessionGroups,
  renameSessionGroup,
  reorderSessionGroups,
  setSessionGroup,
  type SessionGroupRow,
} from '../lib/session-groups';

const projectParams = z.object({ projectId: z.string() });
const groupParams = projectParams.extend({ groupId: z.string() });
const sessionParams = projectParams.extend({ sessionId: z.string().min(1).max(128) });

const GROUP_NOT_FOUND = { error: 'No such session group in this project.', code: 'group_not_found' } as const;
const NAME_TAKEN = { error: 'Another group in this project already has that name.', code: 'group_name_taken' } as const;

function serializeGroup(row: SessionGroupRow): SessionGroup {
  return {
    group_id: row.groupId,
    name: row.name,
    position: row.position,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** The project and the `session_groups` flag, at the access `need`: the gate of every route here. */
async function loadGroupsProject(c: Context<AppEnv>, need: 'read' | 'session') {
  const projectId = c.req.param('projectId')!;
  const loaded = await loadProjectForUser(c, projectId, need);
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (need === 'read') {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  }
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'session_groups');
  if (gate) return gate;
  return loaded;
}

/** Registers every `/session-groups` route and `PUT /sessions/:id/group`, in dispatch order. */
export function registerSessionGroupsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/session-groups',
      tags: ['sessions'],
      summary: 'List the session groups of a project',
      description: 'Every member sees the same groups in the same order. List a group’s sessions with `GET /sessions?group=<group_id>`.',
      ...auth,
      request: { params: projectParams },
      responses: { 200: json(SessionGroupListSchema, 'The groups, in order'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'read');
      if (loaded instanceof Response) return loaded;
      const groups = await listSessionGroups(loaded.row.projectId);
      return c.json({ groups: groups.map(serializeGroup) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/session-groups',
      tags: ['sessions'],
      summary: 'Create a session group',
      description: 'The new group goes last in the order. A name another group of the project has, in any case, is refused (409 `group_name_taken`); a project holds at most 50 groups (409 `group_limit`).',
      ...auth,
      request: {
        params: projectParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupCreateInputSchema } } },
      },
      responses: { 201: json(SessionGroupSchema, 'The new group'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const result = await createSessionGroup({
        accountId: loaded.row.accountId,
        projectId: loaded.row.projectId,
        name: c.req.valid('json').name,
        createdBy: loaded.userId,
      });
      if (!result.ok) {
        return result.code === 'group_limit'
          ? c.json({ error: 'This project already has 50 session groups.', code: 'group_limit' }, 409)
          : c.json(NAME_TAKEN, 409);
      }
      return c.json(serializeGroup(result.group), 201);
    },
  );

  // Before `/{groupId}`: `order` is not a group id.
  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/session-groups/order',
      tags: ['sessions'],
      summary: 'Reorder the session groups of a project',
      description: 'Send every group id of the project once, in the new order. A list that is out of date (a group missing, added or foreign) changes nothing and answers 409 `group_order_stale`: read the list again.',
      ...auth,
      request: {
        params: projectParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupOrderInputSchema } } },
      },
      responses: { 200: json(SessionGroupListSchema, 'The groups, in the new order'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const result = await reorderSessionGroups(loaded.row.projectId, c.req.valid('json').group_ids);
      if (!result.ok) {
        return c.json({ error: 'The group list changed. Read it again and resend the order.', code: 'group_order_stale' }, 409);
      }
      return c.json({ groups: result.groups.map(serializeGroup) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/session-groups/{groupId}',
      tags: ['sessions'],
      summary: 'Rename a session group',
      ...auth,
      request: {
        params: groupParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupUpdateInputSchema } } },
      },
      responses: { 200: json(SessionGroupSchema, 'The renamed group'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const groupId = c.req.param('groupId')!;
      if (!isUuid(groupId)) return c.json(GROUP_NOT_FOUND, 404);
      const result = await renameSessionGroup(loaded.row.projectId, groupId, c.req.valid('json').name);
      if (!result.ok) return result.code === 'group_not_found' ? c.json(GROUP_NOT_FOUND, 404) : c.json(NAME_TAKEN, 409);
      return c.json(serializeGroup(result.group), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/session-groups/{groupId}',
      tags: ['sessions'],
      summary: 'Delete a session group',
      description: 'Its sessions stay and are in no group; the groups after it move up one place.',
      ...auth,
      request: { params: groupParams },
      responses: { 200: json(OkResponseSchema, 'Deleted'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const groupId = c.req.param('groupId')!;
      if (!isUuid(groupId) || !(await deleteSessionGroup(loaded.row.projectId, groupId))) {
        return c.json(GROUP_NOT_FOUND, 404);
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/sessions/{sessionId}/group',
      tags: ['sessions'],
      summary: 'File a session into a session group',
      description: '`group_id` files the session into that group of its project; `null` takes it out of its group. The session keeps its `updated_at`, so it keeps its place in the list.',
      ...auth,
      request: {
        params: sessionParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupAssignInputSchema } } },
      },
      responses: { 200: json(SessionGroupAssignmentSchema, 'The session and its group'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const sessionId = c.req.param('sessionId')!;
      const guard = await guardSession(c, loaded, sessionId, 'read');
      if (!guard.ok) return c.json({ error: guard.error }, guard.status);
      const result = await setSessionGroup(loaded.row.projectId, sessionId, c.req.valid('json').group_id);
      if (!result.ok) {
        return result.code === 'group_not_found' ? c.json(GROUP_NOT_FOUND, 404) : c.json({ error: 'Not found' }, 404);
      }
      return c.json({ session_id: sessionId, group_id: result.groupId }, 200);
    },
  );
}
