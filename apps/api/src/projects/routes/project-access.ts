/** Project members: the access roster and per-member role changes and removal. */
import { PROJECT_ACTIONS } from '../../iam';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { actorOf } from '../../iam/actor';
import { revokeProjectRole } from '../../iam/assignments';
import { parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR } from '../../iam/roles';
import { auth, errors, json, lenientBody } from '../../openapi';
import { isAccountManager, type AccountRole } from '../access';
import { buildProjectAccessView } from '../lib/project-access-view';
import { createRoute, z } from '@hono/zod-openapi';
import {
  grantProjectRole,
  loadProjectForUser,
  parseExpiresAtBody,
  assertProjectCapability,
} from '../lib/access';
import { AccessMemberSchema, projectsApp } from '../lib/app';
import { getAccountMembership } from '../lib/user-identity';
import { readJsonObject } from '../../lib/http-body';
export function registerProjectAccessRoutes(): void {
  // GET /v1/projects/:projectId/access
  // Lists every account member and their explicit/effective project access.

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/access',
      tags: ['access'],
      summary: 'List project members and their roles',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
        },
      responses: {
          200: json(z.array(AccessMemberSchema), 'Access members'),
          ...errors(404),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ);

    return c.json(await buildProjectAccessView(loaded));
  },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/access/{userId}',
      tags: ['access'],
      summary: 'Set a member\'s role on a project',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), userId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              role: z.enum(['manager', 'member']).openapi({ description: 'Project role.' }),
              expires_at: z.string().optional().openapi({ description: 'ISO-8601 expiry. null removes it.' }),
            }) } } },
        },
      responses: {
          200: json(z.any(), 'OK'),
          ...errors(400, 404),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const targetUserId = c.req.param('userId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Member management is admin-only; loadProjectForUser('manage') now
    // resolves to project.write, so we add an explicit
    // stricter gate here.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    const body = await readJsonObject(c);
    const role = parseAssignableProjectRole(body.role);
    if (!role) return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);
    const expires = parseExpiresAtBody(body.expires_at);
    if (!expires.ok) return c.json({ error: expires.error }, 400);

    const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
    if (!targetMembership) {
      return c.json({ error: 'User is not a member of this account' }, 404);
    }

    const targetAccountRole = targetMembership.accountRole as AccountRole;
    if (isAccountManager(targetAccountRole)) {
      // An owner/admin already has implicit Manager on every project, so a direct
      // project-role assignment adds nothing and only confuses the members list.
      // The route asserted project.members.manage above; `revokeProjectRole`
      // carries that through rather than re-deriving a different permission.
      await revokeProjectRole(await actorOf(c, loaded.row.accountId), loaded.row.accountId, projectId, {
        type: 'user',
        id: targetUserId,
      });
      invalidateIamCacheForUser(targetUserId);

      return c.json({
        user_id: targetUserId,
        account_role: targetAccountRole,
        project_role: null,
        effective_project_role: 'manager',
        has_implicit_access: true,
      });
    }

    await grantProjectRole({
      accountId: loaded.row.accountId,
      projectId,
      userId: targetUserId,
      role,
      grantedBy: loaded.userId,
      expiresAt: expires.value,
    });

    return c.json({
      user_id: targetUserId,
      account_role: targetAccountRole,
      project_role: role,
      effective_project_role: role,
      has_implicit_access: false,
    });
  },
  );

  // DELETE /v1/projects/:projectId/access/:userId

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/access/{userId}',
      tags: ['access'],
      summary: 'Remove a member from a project',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), userId: z.string() }),
        },
      responses: {
          200: json(z.any(), 'OK'),
          ...errors(404, 409),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const targetUserId = c.req.param('userId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
    if (!targetMembership) {
      return c.json({ error: 'User is not a member of this account' }, 404);
    }

    const targetAccountRole = targetMembership.accountRole as AccountRole;
    if (isAccountManager(targetAccountRole)) {
      return c.json({ error: 'Owners and admins have implicit access to every project' }, 409);
    }

    await revokeProjectRole(await actorOf(c, loaded.row.accountId), loaded.row.accountId, projectId, {
      type: 'user',
      id: targetUserId,
    });
    invalidateIamCacheForUser(targetUserId);

    return c.json({ ok: true });
  },
  );
}
