import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { config } from '../../config';
import { combinedAuth } from '../../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { db } from '../../shared/db';
import { listProjectsForWorkspace, loadTeamsInstall } from '../install-store';
import { consumePendingTeamsAuthMessage } from './auth-resume';
import { isAccountMember, linkTeamsIdentity } from './identity';
import { verifyTeamsLoginState } from './login';
import { createOrJoinTeamsConversationSession } from './session';

export const teamsIdentityApp = makeOpenApiApp();

teamsIdentityApp.openapi(
  createRoute({
    method: 'get',
    path: '/login/{token}',
    tags: ['channels'],
    summary: 'Redirect a Teams login link to the web login page',
    request: { params: z.object({ token: z.string().min(1) }) },
    responses: { 200: { description: 'HTML redirect to web Teams login page' } },
  }),
  async (c: Context) => {
    const token = c.req.param('token') ?? '';
    const base = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
    const target = `${base}/teams/login/${encodeURIComponent(token)}`;
    return c.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <title>Opening Kortix</title>
  </head>
  <body>
    <p>Opening Kortix...</p>
    <script>window.location.replace(${JSON.stringify(target)});</script>
    <p><a href="${target}">Continue to Kortix</a></p>
  </body>
</html>`);
  },
);

const BindBody = z.object({ token: z.string().min(1) });
const BindResult = z.object({
  ok: z.boolean(),
  workspaceName: z.string().nullable(),
  hasAccess: z.boolean(),
  resumed: z.boolean(),
});

teamsIdentityApp.openapi(
  createRoute({
    method: 'post',
    path: '/bind',
    tags: ['channels'],
    summary: 'Bind the calling Kortix user to a Teams user from a login token',
    ...auth,
    middleware: [combinedAuth] as const,
    request: { body: { content: { 'application/json': { schema: BindBody } } } },
    responses: { 200: json(BindResult, 'Identity linked'), ...errors(400, 403, 404, 410, 503) },
  }),
  async (c: Context) => {
    if (!config.TEAMS_REQUIRE_USER_IDENTITY) return c.json({ error: 'Not found' }, 404);
    if (!config.MICROSOFT_APP_PASSWORD) {
      return c.json({ error: 'Teams identity binding is not configured on this server.' }, 503);
    }
    const userId = c.get('userId') as string;
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!token) return c.json({ error: 'Missing token' }, 400);

    const payload = verifyTeamsLoginState(token);
    if (!payload)
      return c.json(
        { error: 'This link is invalid or has expired. Run the Teams login again.' },
        410,
      );

    const projectIds = await listProjectsForWorkspace('teams', payload.tenantId);
    if (projectIds.length === 0) {
      return c.json({ error: 'This Teams tenant is not connected to any Kortix project.' }, 403);
    }
    const accountRows = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(inArray(projects.projectId, projectIds));
    const accountIds = Array.from(new Set(accountRows.map((r) => r.accountId)));
    const memberships = await Promise.all(accountIds.map((a) => isAccountMember(userId, a)));
    const hasAccess = memberships.some(Boolean);

    await linkTeamsIdentity({
      tenantId: payload.tenantId,
      teamsUserId: payload.teamsUserId,
      userId,
    });

    const pending = await consumePendingTeamsAuthMessage({
      pendingId: payload.pendingId,
      tenantId: payload.tenantId,
      teamsUserId: payload.teamsUserId,
    });
    let resumed = false;
    if (pending) {
      resumed = true;
      void createOrJoinTeamsConversationSession({
        projectId: pending.projectId,
        tenantId: payload.tenantId,
        conversationId: pending.activity.conversation?.id ?? '',
        activity: pending.activity,
      }).catch((err) =>
        console.error('[teams-auth] failed to resume pending Teams message after bind', err),
      );
    }

    const workspaceName =
      (await loadTeamsInstall(projectIds[0]).catch(() => null))?.teamName ?? null;
    return c.json({ ok: true, workspaceName, hasAccess, resumed });
  },
);
