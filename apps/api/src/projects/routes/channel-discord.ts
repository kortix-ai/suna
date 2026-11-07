/**
 * Discord channel: whether this server has the Kortix Discord application and
 * the "Add to Discord" link, the server installation, the OAuth completion,
 * the allowed list, and disconnect. The access routes (users, photos, allow,
 * remove, dismiss) come from registerChannelAccessRoutes (channel-access.ts).
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { discordAccessPort } from '../../channels/discord/access';
import { discordConfigured } from '../../channels/discord/api';
import { DISCORD_USER_ID, loadDiscordInstall, releaseDiscordInstall } from '../../channels/discord/installs';
import { buildDiscordInstallUrl, completeDiscordOauthInstall } from '../../channels/discord/oauth';
import { CHANNEL_MAX_ALLOWED_USERS, setChannelAllowedUsers } from '../../channels/core/channel-access';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { PROJECT_ACTIONS } from '../../iam';
import { logger } from '../../lib/logger';
import { readJsonObject } from '../../shared/http-body';
import { auth, errors, json } from '../../openapi';
import { AnyObject, projectsApp } from '../lib/app';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import type { AppEnv } from '../../types';
import { channelContext, channelNotConnected, registerChannelAccessRoutes } from './channel-access';
import { workspaceIdParam } from '../../shared/route-params';

const UserIds = z.array(z.string().regex(DISCORD_USER_ID)).max(CHANNEL_MAX_ALLOWED_USERS);

function reconcileInBackground(projectId: string): void {
  // Not awaited: on a real project the reconcile reads the repo and can outlast the request deadline.
  void reconcileChannelConnectors(projectId).catch((error) =>
    logger.warn('[discord] channel connector reconcile failed', { projectId, error: String(error) }),
  );
}

export function registerChannelDiscordRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/channels/discord/mode',
      tags: ['channels'],
      summary: 'Whether Discord is available, and the Add to Discord link',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
      responses: {
        200: json(z.object({ available: z.boolean(), install_url: z.string().nullable() }), 'OK'),
        ...errors(403, 404),
      },
    }),
    async (c: Context<AppEnv>) => {
      const projectId = workspaceIdParam(c) ?? '';
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      if (!discordConfigured()) return c.json({ available: false, install_url: null }, 200);
      // The link carries a signed state for this user and project; only a writer gets one.
      const canWrite = await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE)
        .then(() => true)
        .catch(() => false);
      return c.json({ available: true, install_url: canWrite ? buildDiscordInstallUrl(projectId, loaded.userId) : null }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/channels/discord/installation',
      tags: ['channels'],
      summary: 'Get the Discord server installation',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
      responses: { 200: json(z.any(), 'OK'), ...errors(403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await channelContext(c);
      if (ctx.response) return ctx.response;
      return c.json(await discordAccessPort.installation(ctx.projectId));
    },
  );

  registerChannelAccessRoutes(discordAccessPort);

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/channels/discord/oauth/complete',
      tags: ['channels'],
      summary: 'Complete the Add to Discord install',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: z.object({ code: z.string().min(1).max(512), state: z.string().min(1).max(4096) }) } } },
      },
      responses: {
        200: json(z.object({ redirect_url: z.string() }), 'Installed, or the outcome to show'),
        ...errors(400, 403, 404, 503),
      },
    }),
    async (c: Context<AppEnv>) => {
      const projectId = workspaceIdParam(c) ?? '';
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      const body = await readJsonObject(c);
      const text = (value: unknown) => (typeof value === 'string' ? value : '');
      const result = await completeDiscordOauthInstall({ projectId, userId: loaded.userId, code: text(body.code), state: text(body.state) });
      if (!result.ok) return c.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status);
      return c.json({ redirect_url: result.redirectUrl }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/channels/discord/allowed-users',
      tags: ['channels'],
      summary: 'Set the Discord users allowed to talk to the bot',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        // `{ user_ids: string[] }`, validated in the handler so every refusal carries a `code`.
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await channelContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (ctx.response) return ctx.response;
      const parsed = UserIds.safeParse(((await c.req.json().catch(() => null)) as { user_ids?: unknown } | null)?.user_ids);
      if (!parsed.success) return c.json({ error: 'user_ids must be numeric Discord user ids', code: 'discord_user_ids_invalid' }, 400);
      if (!(await loadDiscordInstall(ctx.projectId))) return channelNotConnected(c, discordAccessPort);
      await setChannelAllowedUsers('discord', ctx.projectId, parsed.data);
      return c.json(await discordAccessPort.installation(ctx.projectId));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/channels/discord',
      tags: ['channels'],
      summary: 'Disconnect the Discord server',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
      responses: { 200: json(z.object({ ok: z.boolean() }), 'OK'), ...errors(403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await channelContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (ctx.response) return ctx.response;
      // The bot leaves the server when no other project has it.
      await releaseDiscordInstall(ctx.projectId);
      reconcileInBackground(ctx.projectId);
      return c.json({ ok: true });
    },
  );
}
