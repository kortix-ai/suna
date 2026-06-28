/**
 * Slack `/login` — the AUTHENTICATED bind half.
 *
 * The Slack slash command mints a short-lived signed token (channels/slack/login.ts)
 * and DMs the user a link to the web page. That page requires a normal Kortix
 * login and POSTs the token here with the user's bearer. We verify the token,
 * confirm the now-known Kortix user is a member of the Slack workspace's project
 * account, and persist the (workspace, slack_user) → kortix_user mapping.
 *
 * Same trust model as accepting a team invite: the token proves which Slack user
 * asked to link; the bearer proves which Kortix user is accepting.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { inArray } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { combinedAuth } from '../../middleware/auth';
import { listProjectsForWorkspace, loadSlackTeamNameForProject } from '../install-store';
import { spawnAgentTurn } from './dispatch';
import { consumePendingSlackAuthMessage, replaceSlackAuthPromptConnected } from './auth-resume';
import { verifyLoginState } from './login';
import { isAccountMember, linkSlackIdentity } from './identity';

export const slackIdentityApp = makeOpenApiApp();

slackIdentityApp.openapi(
  createRoute({
    method: 'get',
    path: '/login/{token}',
    tags: ['channels'],
    summary: 'Redirect a Slack login link to the web login page',
    request: { params: z.object({ token: z.string().min(1) }) },
    responses: {
      200: { description: 'HTML redirect to web Slack login page' },
    },
  }),
  async (c: any) => {
    const token = c.req.param('token');
    const base = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
    const target = `${base}/slack/login/${encodeURIComponent(token)}`;
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
  // Whether the now-linked user is actually a member of the workspace's account.
  // Connecting is decoupled from access: a non-member links successfully
  // (hasAccess=false) and then requests access in-thread. The runtime gate still
  // blocks any agent run until they're an approved member.
  hasAccess: z.boolean(),
  resumed: z.boolean(),
});

slackIdentityApp.openapi(
  createRoute({
    method: 'post',
    path: '/bind',
    tags: ['channels'],
    summary: 'Bind the calling Kortix user to a Slack user from a /login token',
    ...auth,
    middleware: [combinedAuth] as const,
    request: { body: { content: { 'application/json': { schema: BindBody } } } },
    responses: {
      200: json(BindResult, 'Identity linked'),
      ...errors(400, 403, 404, 410),
    },
  }),
  async (c: any) => {
    // Whole feature is flag-gated — the bind endpoint is inert when off.
    if (!config.SLACK_REQUIRE_USER_IDENTITY) return c.json({ error: 'Not found' }, 404);
    const userId = c.get('userId') as string;
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!token) return c.json({ error: 'Missing token' }, 400);

    const payload = verifyLoginState(token);
    if (!payload) return c.json({ error: 'This link is invalid or has expired. Run `/kortix login` again.' }, 410);

    // The workspace must be connected to at least one Kortix project, and the
    // accepting user must be a member of that project's account — otherwise a
    // stranger could bind into a workspace they have no access to.
    const projectIds = await listProjectsForWorkspace('slack', payload.teamId);
    if (projectIds.length === 0) {
      return c.json({ error: 'This Slack workspace is not connected to any Kortix project.' }, 403);
    }
    const accountRows = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(inArray(projects.projectId, projectIds));
    const accountIds = Array.from(new Set(accountRows.map((r) => r.accountId)));
    const memberships = await Promise.all(accountIds.map((a) => isAccountMember(userId, a)));
    const hasAccess = memberships.some(Boolean);

    // Link regardless of membership. Connecting your Kortix account is decoupled
    // from having access: we establish WHO this Slack user is so a non-member can
    // request access right in the thread. This is safe — the link grants nothing
    // on its own; the runtime gate (resolveSlackActor) still requires membership
    // before any agent runs, so a linked non-member can do nothing until an admin
    // approves. The workspace-must-be-connected check above still stands.
    await linkSlackIdentity({ teamId: payload.teamId, slackUserId: payload.slackUserId, userId });

    const pending = await consumePendingSlackAuthMessage({
      pendingId: payload.pendingId,
      teamId: payload.teamId,
      slackUserId: payload.slackUserId,
    });
    if (pending) {
      void replaceSlackAuthPromptConnected(pending.slackResponseUrl, { hasAccess });
      void spawnAgentTurn(pending.projectId, pending.envelope, pending.event).catch((err) => {
        console.error('[slack-auth] failed to resume pending Slack message after bind', err);
      });
    }

    const workspaceName = projectIds.length
      ? await loadSlackTeamNameForProject(projectIds[0]).catch(() => null)
      : null;
    return c.json({ ok: true, workspaceName: workspaceName || null, hasAccess, resumed: !!pending });
  },
);
