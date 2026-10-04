/** Project access requests: request, list, approve, and reject. */
import { PROJECT_ACTIONS, authorize } from '../../services/iam';
import { actorOf } from '../../services/iam/actor';
import { parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR } from '../../services/iam/roles';
import { auth, errors, json, lenientBody } from '../openapi';
import { db } from '../../lib/db';
import { isAccountManager } from '../../services/projects/access';
import { createRoute, z } from '@hono/zod-openapi';
import { projectAccessRequests, projects } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import {
  ensureOrgMembership,
  grantProjectRole,
  loadProjectForUser,
  assertProjectCapability,
} from '../../services/projects/lib/access';
import { notifyProjectAccessRequestManagers } from '../../services/projects/lib/access-requests';
import { projectsApp } from './app';
import { getAccountMembership } from '../../services/projects/lib/user-identity';
import { readJsonObject } from '../../lib/http-body';

function serializeProjectAccessRequest(row: typeof projectAccessRequests.$inferSelect) {
  return {
    request_id: row.requestId,
    account_id: row.accountId,
    project_id: row.projectId,
    requester_user_id: row.requesterUserId,
    requester_email: row.requesterEmail,
    message: row.message ?? null,
    status: row.status,
    reviewed_by: row.reviewedBy ?? null,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
export function registerAccessRequestsRoutes(): void {
  // POST /v1/projects/:projectId/access-requests
  // Lets a signed-in user with a project link ask the project's managers for
  // access without mounting the normal project shell (which would otherwise fan
  // out into many 403s). Mirrors the Figma-style "Request access" affordance.

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/access-requests',
      tags: ['access'],
      summary: 'Request access to a project',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              message: z.string().optional().openapi({ description: 'Note to the project managers.' }),
            }) } } },
        },
      responses: {
          200: json(z.any(), 'Existing access request or access state'),
          201: json(z.any(), 'Access request created'),
          ...errors(404),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId') as string;
    const requesterEmail = ((c.get('userEmail') as string | undefined) ?? '').trim().toLowerCase();
    const body = await readJsonObject(c);
    const messageRaw = typeof body.message === 'string' ? body.message.trim() : '';
    const message = messageRaw ? messageRaw.slice(0, 2000) : null;

    const [project] = await db
      .select({
        accountId: projects.accountId,
        projectId: projects.projectId,
        status: projects.status,
      })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project || project.status === 'archived') return c.json({ error: 'Not found' }, 404);

    const membership = await getAccountMembership(userId, project.accountId);
    if (membership) {
      // The one route that runs the engine EXPECTING a denial — "I can't get in,
      // let me ask" (routes.md §5.14). It must stay non-throwing.
      const verdict = await authorize(await actorOf(c, project.accountId), PROJECT_ACTIONS.PROJECT_READ, {
        type: 'project',
        id: projectId,
      });
      if (verdict.allowed) {
        return c.json({ status: 'already_has_access', project_id: projectId });
      }
    }

    const [existing] = await db
      .select()
      .from(projectAccessRequests)
      .where(and(
        eq(projectAccessRequests.projectId, projectId),
        eq(projectAccessRequests.requesterUserId, userId),
        eq(projectAccessRequests.status, 'pending'),
      ))
      .limit(1);

    if (existing) {
      return c.json({ status: 'pending', request: serializeProjectAccessRequest(existing) });
    }

    const [created] = await db
      .insert(projectAccessRequests)
      .values({
        accountId: project.accountId,
        projectId,
        requesterUserId: userId,
        requesterEmail: requesterEmail || userId,
        message,
      })
      .returning();

    await notifyProjectAccessRequestManagers({
      accountId: project.accountId,
      projectId,
      requesterUserId: userId,
      requesterEmail: created.requesterEmail,
      message,
    });

    return c.json({ status: 'created', request: serializeProjectAccessRequest(created) }, 201);
  },
  );

  // GET /v1/projects/:projectId/access-requests
  // Managers review pending "request access" asks from the Members screen.

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/access-requests',
      tags: ['access'],
      summary: 'List project access requests',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
        },
      responses: {
          200: json(z.any(), 'Pending access requests'),
          ...errors(404),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor is 'read' (project membership); the real gate is the members.manage
    // leaf below, so a custom role granting ONLY members.manage (no project.write)
    // works, and — matching the sibling approve/reject routes — a plain member
    // (project.write but not members.manage) can't list pending access requests.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    const rows = await db
      .select()
      .from(projectAccessRequests)
      .where(and(
        eq(projectAccessRequests.projectId, projectId),
        eq(projectAccessRequests.status, 'pending'),
      ))
      .orderBy(desc(projectAccessRequests.createdAt));

    return c.json({ requests: rows.map(serializeProjectAccessRequest) });
  },
  );

  // POST /v1/projects/:projectId/access-requests/:requestId/approve

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/access-requests/{requestId}/approve',
      tags: ['access'],
      summary: 'Approve a project access request',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), requestId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              role: z.enum(['manager', 'member']).optional().openapi({ description: 'Role to grant. Default member.' }),
            }) } } },
        },
      responses: {
        200: json(z.any(), 'Access request approved'),
          ...errors(400, 404, 409),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const requestId = c.req.param('requestId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Approving an access request grants a project role to the requester —
    // membership management, NOT plain write. loadProjectForUser('manage') only
    // maps to project.write, so without this a non-manager could approve
    // requests and even hand out the 'manager' role. Gate on members.manage.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    const body = await readJsonObject(c);
    const role = body.role === undefined ? 'member' : parseAssignableProjectRole(body.role);
    if (!role) return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);

    const [request] = await db
      .select()
      .from(projectAccessRequests)
      .where(and(
        eq(projectAccessRequests.requestId, requestId),
        eq(projectAccessRequests.projectId, projectId),
      ))
      .limit(1);
    if (!request) return c.json({ error: 'Not found' }, 404);
    if (request.status !== 'pending') {
      return c.json({ error: 'Access request has already been reviewed' }, 409);
    }

    const targetAccountRole = await ensureOrgMembership(
      loaded.row.accountId,
      request.requesterUserId,
    );

    if (!isAccountManager(targetAccountRole)) {
      await grantProjectRole({
        accountId: loaded.row.accountId,
        projectId,
        userId: request.requesterUserId,
        role,
        grantedBy: loaded.userId,
      });
    }

    const [updated] = await db
      .update(projectAccessRequests)
      .set({
        status: 'approved',
        reviewedBy: loaded.userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectAccessRequests.requestId, requestId))
      .returning();

    return c.json({
      request: serializeProjectAccessRequest(updated),
      member: {
        user_id: request.requesterUserId,
        email: request.requesterEmail,
        account_role: targetAccountRole,
        project_role: isAccountManager(targetAccountRole) ? null : role,
        effective_project_role: isAccountManager(targetAccountRole) ? 'manager' : role,
        has_implicit_access: isAccountManager(targetAccountRole),
      },
    });
  },
  );

  // POST /v1/projects/:projectId/access-requests/:requestId/reject

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/access-requests/{requestId}/reject',
      tags: ['access'],
      summary: 'Reject a project access request',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), requestId: z.string() }),
        },
      responses: {
        200: json(z.any(), 'Access request rejected'),
          ...errors(404, 409),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const requestId = c.req.param('requestId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Reviewing an access request is membership management — gate on
    // members.manage (loadProjectForUser('manage') only enforces project.write).
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    const [request] = await db
      .select()
      .from(projectAccessRequests)
      .where(and(
        eq(projectAccessRequests.requestId, requestId),
        eq(projectAccessRequests.projectId, projectId),
      ))
      .limit(1);
    if (!request) return c.json({ error: 'Not found' }, 404);
    if (request.status !== 'pending') {
      return c.json({ error: 'Access request has already been reviewed' }, 409);
    }

    const [updated] = await db
      .update(projectAccessRequests)
      .set({
        status: 'rejected',
        reviewedBy: loaded.userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectAccessRequests.requestId, requestId))
      .returning();

    return c.json({ request: serializeProjectAccessRequest(updated) });
  },
  );
}
