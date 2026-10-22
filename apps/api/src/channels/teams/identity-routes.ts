import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { config } from '../../config';
import { combinedAuth } from '../../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { db } from '../../shared/db';
import { listProjectsForWorkspace, loadTeamsAppIdForProject, loadTeamsInstall } from '../install-store';
import { consumePendingTeamsAuthMessage, peekPendingTeamsAuthSenderName } from './auth-resume';
import { chatUser, completeChatLogin } from '../core/identity';
import { buildDenialError } from '../../iam/denial-message';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { verifyTeamsLoginState } from './login';
import { createOrJoinTeamsConversationSession } from './session';
import { confirmTeamsConnected } from './identity';
import { readJsonObject } from '../../shared/http-body';

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
const PreviewResult = z.object({
  service: z.literal('teams'),
  workspaceName: z.string().nullable(),
  chatUserId: z.string(),
  chatUserName: z.string().nullable(),
});

// Which Teams account a login link would link, shown on the consent screen
// BEFORE the user presses Connect. Read-only: it links nothing and consumes
// nothing. Same token and tenant checks as /bind.
teamsIdentityApp.openapi(
  createRoute({
    method: 'post',
    path: '/preview',
    tags: ['channels'],
    summary: 'Show which Teams account a login token would link',
    ...auth,
    middleware: [combinedAuth] as const,
    request: { body: { content: { 'application/json': { schema: BindBody } } } },
    responses: {
      200: json(PreviewResult, 'The Teams account behind the token'),
      ...errors(400, 403, 404, 410, 503),
    },
  }),
  async (c: Context) => {
    if (!config.TEAMS_REQUIRE_USER_IDENTITY) return c.json({ error: 'Not found' }, 404);
    if (!config.MICROSOFT_APP_PASSWORD) {
      return c.json({ error: 'Teams identity binding is not configured on this server.' }, 503);
    }
    const body = await readJsonObject(c);
    const token = typeof body.token === 'string' ? body.token : '';
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
    const [install, chatUserName] = await Promise.all([
      loadTeamsInstall(projectIds[0]!).catch(() => null),
      peekPendingTeamsAuthSenderName({
        pendingId: payload.pendingId,
        tenantId: payload.tenantId,
        teamsUserId: payload.teamsUserId,
      }),
    ]);
    return c.json({
      service: 'teams' as const,
      workspaceName: install?.teamName ?? null,
      chatUserId: payload.teamsUserId,
      chatUserName,
    });
  },
);

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
    responses: { 200: json(BindResult, 'Identity linked'), ...errors(400, 403, 404, 409, 410, 503) },
  }),
  async (c: Context) => {
    if (!config.TEAMS_REQUIRE_USER_IDENTITY) return c.json({ error: 'Not found' }, 404);
    if (!config.MICROSOFT_APP_PASSWORD) {
      return c.json({ error: 'Teams identity binding is not configured on this server.' }, 503);
    }
    const userId = c.get('userId') as string;
    const body = await readJsonObject(c);
    const token = typeof body.token === 'string' ? body.token : '';
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

    const outcome = await completeChatLogin({
      user: chatUser('teams', payload.tenantId, payload.teamsUserId),
      userId,
      login: payload,
      accountIds,
      mfaAal: c.get('mfaAal'),
      tokenId: c.get('iamTokenId'),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'mfa_required') {
        throw buildDenialError(PROJECT_ACTIONS.PROJECT_SESSION_START, 'account_mfa_required');
      }
      return outcome.reason === 'used'
        ? c.json({ error: 'This link was already used. Send /login to the Kortix bot in Teams for a new one.' }, 410)
        : c.json(
            {
              error:
                'This Teams account is connected to a different Kortix account. Send /logout to the Kortix bot in Teams, then /login.',
            },
            409,
          );
    }
    const { hasAccess } = outcome;

    const pending = outcome.fresh
      ? await consumePendingTeamsAuthMessage({
          pendingId: payload.pendingId,
          tenantId: payload.tenantId,
          teamsUserId: payload.teamsUserId,
        })
      : null;
    let resumed = false;
    if (pending) {
      resumed = true;
      // A project on its own bot resumes only into its own sessions, as its
      // webhook would have delivered the message (ownThreadsOnly).
      const ownBot = Boolean(await loadTeamsAppIdForProject(pending.projectId).catch(() => null));
      void createOrJoinTeamsConversationSession({
        projectId: pending.projectId,
        tenantId: payload.tenantId,
        conversationId: pending.activity.conversation?.id ?? '',
        activity: pending.activity,
        ownThreadsOnly: ownBot,
      }).catch((err) =>
        console.error('[teams-auth] failed to resume pending Teams message after bind', err),
      );
    }

    // Say so in Teams too: the browser tab is the only place that said it, and
    // the person is back in Teams. Slack posts "Slack connected — picking up
    // your message". Best effort: the 1:1 chat opens only when the app is
    // installed for them, which is where the sign-in link was sent. A reload
    // of a used link (`fresh` false) connected nothing new, so it says nothing.
    if (outcome.fresh) {
      void confirmTeamsConnected({
        projectId: pending?.projectId ?? projectIds[0]!,
        tenantId: payload.tenantId,
        teamsUserId: payload.teamsUserId,
        userId,
        resumed,
        hasAccess,
      });
    }

    const workspaceName =
      (await loadTeamsInstall(projectIds[0]).catch(() => null))?.teamName ?? null;
    return c.json({ ok: true, workspaceName, hasAccess, resumed });
  },
);
