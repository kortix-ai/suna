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
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { combinedAuth } from '../../middleware/auth';
import { listProjectsForWorkspace, loadSlackTeamNameForProject } from '../install-store';
import { verifyLoginState } from './login';
import { isAccountMember, linkSlackIdentity } from './identity';

export const slackIdentityApp = makeOpenApiApp();

const BindBody = z.object({ token: z.string().min(1) });
const BindResult = z.object({ ok: z.boolean(), workspaceName: z.string().nullable() });

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
      ...errors(400, 403, 410),
    },
  }),
  async (c: any) => {
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
    if (!memberships.some(Boolean)) {
      return c.json(
        { error: "You're not a member of this workspace's Kortix account. Ask an admin to add you, then try again." },
        403,
      );
    }

    await linkSlackIdentity({ teamId: payload.teamId, slackUserId: payload.slackUserId, userId });

    const workspaceName = projectIds.length
      ? await loadSlackTeamNameForProject(projectIds[0]).catch(() => null)
      : null;
    return c.json({ ok: true, workspaceName: workspaceName || null });
  },
);
