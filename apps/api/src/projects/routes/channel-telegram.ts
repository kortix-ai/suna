/** Telegram channel: connect a bot by token, allow senders and access requests, disconnect. */
import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { TELEGRAM_TOKEN_PATTERN, TELEGRAM_UPDATES, type TelegramBot, TelegramApiError, telegramCall } from '../../channels/telegram/api';
import {
  addTelegramAllowedUser,
  deleteTelegramInstall,
  dismissTelegramAccessRequest,
  loadTelegramBotToken,
  loadTelegramInstall,
  removeTelegramAllowedUser,
  saveTelegramInstall,
  setTelegramAllowedUserIds,
  TELEGRAM_MAX_ALLOWED_USERS,
  TELEGRAM_USER_ID,
  type TelegramInstall,
} from '../../channels/telegram/installs';
import { listTelegramUsers, telegramUserPhoto } from '../../channels/telegram/profiles';
import { config } from '../../config';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { PROJECT_ACTIONS } from '../../iam';
import { logger } from '../../lib/logger';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import type { AppEnv } from '../../types';

const UserIds = z.array(z.string().regex(TELEGRAM_USER_ID)).max(TELEGRAM_MAX_ALLOWED_USERS);

const TelegramUserSchema = z.object({
  user_id: z.string(),
  username: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  photo_version: z.string().nullable().openapi({ description: 'Changes when the photo changes; null: no photo' }),
  known: z.boolean().openapi({ description: 'False: Telegram gave no profile and nothing is stored' }),
});
const TelegramUsersSchema = z.object({
  allowed: z.array(TelegramUserSchema),
  requests: z.array(TelegramUserSchema.extend({ last_seen: z.string() })),
});
const UserParams = z.object({ projectId: z.string(), user_id: z.string() });

function installBody(install: TelegramInstall | null) {
  if (!install) return null;
  return {
    bot_id: install.botId,
    username: install.username,
    allowed_user_ids: install.allowedUserIds,
    access_request_count: install.accessRequests.length,
  };
}

/** Load the project and check `capability` (none: project read is enough). */
async function telegramContext(c: Context<AppEnv>, capability?: string) {
  const projectId = c.req.param('projectId') ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };
  if (capability) await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, capability);
  return { response: null, projectId } as const;
}

const notConnected = (c: Context<AppEnv>) => c.json({ error: 'Telegram is not connected', code: 'telegram_not_connected' }, 404);
const invalidUserId = (c: Context<AppEnv>) =>
  c.json({ error: 'user_id must be a numeric Telegram user id', code: 'telegram_user_ids_invalid' }, 400);

/**
 * One list edit by user id (remove, dismiss): idempotent, answers the
 * installation as PUT does.
 */
async function editByUserId(c: Context<AppEnv>, edit: (projectId: string, userId: string) => Promise<void>) {
  const ctx = await telegramContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  if (ctx.response) return ctx.response;
  const userId = c.req.param('user_id') ?? '';
  if (!TELEGRAM_USER_ID.test(userId)) return invalidUserId(c);
  if (!(await loadTelegramInstall(ctx.projectId))) return notConnected(c);
  await edit(ctx.projectId, userId);
  return c.json(installBody(await loadTelegramInstall(ctx.projectId)), 200);
}

function reconcileInBackground(projectId: string): void {
  // Not awaited: on a real project the reconcile reads the repo and can outlast
  // the 25 s request deadline (the Teams install does the same).
  void reconcileChannelConnectors(projectId).catch((error) =>
    logger.warn('[telegram] channel connector reconcile failed', { projectId, error: String(error) }),
  );
}

export function registerChannelTelegramRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/channels/telegram/installation',
      tags: ['channels'],
      summary: 'Get the Telegram bot installation',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(z.any(), 'OK'), ...errors(403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await telegramContext(c);
      if (ctx.response) return ctx.response;
      return c.json(installBody(await loadTelegramInstall(ctx.projectId)));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/channels/telegram/users',
      tags: ['channels'],
      summary: 'List the allowed Telegram users and the access requests',
      description:
        'Allowed users in list order and requests newest first, with names and a photo version from Telegram. ' +
        'A request is a not-allowed user who messaged the bot privately in the last 30 days.',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(TelegramUsersSchema, 'OK'), ...errors(403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      // Names and photos are personal data: the connector readers only.
      const ctx = await telegramContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
      if (ctx.response) return ctx.response;
      const users = await listTelegramUsers(ctx.projectId);
      return users ? c.json(users) : notConnected(c);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/channels/telegram/users/{user_id}/photo',
      tags: ['channels'],
      summary: "An allowed or requesting Telegram user's profile photo",
      description: 'JPEG bytes. `v` is the `photo_version` from the user list; it only changes the URL when the photo changes.',
      ...auth,
      request: { params: UserParams, query: z.object({ v: z.string().max(128).optional() }) },
      responses: { 200: { description: 'The photo (image/jpeg)' }, ...errors(403, 404, 502) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await telegramContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
      if (ctx.response) return ctx.response;
      const userId = c.req.param('user_id') ?? '';
      const photo = TELEGRAM_USER_ID.test(userId)
        ? await telegramUserPhoto(ctx.projectId, userId)
        : ({ ok: false, code: 'telegram_user_unknown' } as const);
      if (!photo.ok) {
        const message = {
          telegram_not_connected: 'Telegram is not connected',
          telegram_user_unknown: 'This Telegram user is not allowed and has not asked for access',
          telegram_photo_unavailable: 'This Telegram user has no photo the bot can see',
          telegram_unreachable: 'Could not reach Telegram',
        }[photo.code];
        return c.json({ error: message, code: photo.code }, photo.code === 'telegram_unreachable' ? 502 : 404);
      }
      return new Response(photo.bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=86400',
        },
      }) as never;
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/telegram/connect',
      tags: ['channels'],
      summary: 'Connect a Telegram bot',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        // `{ bot_token, allowed_user_ids? }`, validated in the handler so every refusal carries a `code`.
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404, 502) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await telegramContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (ctx.response) return ctx.response;
      const body = (await c.req.json().catch(() => null)) as { bot_token?: unknown; allowed_user_ids?: unknown } | null;
      const token = typeof body?.bot_token === 'string' ? body.bot_token.trim() : '';
      if (!TELEGRAM_TOKEN_PATTERN.test(token)) {
        return c.json({ error: 'bot_token must be the token BotFather gave you (<bot id>:<secret>)', code: 'telegram_token_invalid' }, 400);
      }
      const allowed = body?.allowed_user_ids === undefined ? null : UserIds.safeParse(body.allowed_user_ids);
      if (allowed && !allowed.success) {
        return c.json({ error: 'allowed_user_ids must be numeric Telegram user ids', code: 'telegram_user_ids_invalid' }, 400);
      }

      const webhookSecret = randomBytes(32).toString('hex');
      let bot: TelegramBot;
      try {
        bot = await telegramCall<TelegramBot>(token, 'getMe');
        await telegramCall(token, 'setWebhook', {
          url: `${(config.KORTIX_URL || new URL(c.req.url).origin).replace(/\/+$/, '')}/v1/webhooks/telegram/${ctx.projectId}`,
          secret_token: webhookSecret,
          allowed_updates: TELEGRAM_UPDATES,
          drop_pending_updates: true,
        });
      } catch (error) {
        const rejected = error instanceof TelegramApiError && (error.status === 401 || error.status === 404);
        return c.json(
          {
            error: rejected ? 'Telegram rejected the bot token' : 'Could not reach Telegram',
            code: rejected ? 'telegram_token_rejected' : 'telegram_unreachable',
          },
          rejected ? 400 : 502,
        );
      }

      await saveTelegramInstall({
        projectId: ctx.projectId,
        botId: String(bot.id),
        username: bot.username ?? null,
        token,
        webhookSecret,
      });
      if (allowed?.success) await setTelegramAllowedUserIds(ctx.projectId, allowed.data);
      reconcileInBackground(ctx.projectId);
      return c.json(installBody(await loadTelegramInstall(ctx.projectId)));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/channels/telegram/allowed-users',
      tags: ['channels'],
      summary: 'Set the Telegram users allowed to talk to the bot',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        // `{ user_ids: string[] }`, validated in the handler so every refusal carries a `code`.
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await telegramContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (ctx.response) return ctx.response;
      const parsed = UserIds.safeParse(((await c.req.json().catch(() => null)) as { user_ids?: unknown } | null)?.user_ids);
      if (!parsed.success) {
        return c.json({ error: 'user_ids must be numeric Telegram user ids', code: 'telegram_user_ids_invalid' }, 400);
      }
      if (!(await loadTelegramInstall(ctx.projectId))) return notConnected(c);
      await setTelegramAllowedUserIds(ctx.projectId, parsed.data);
      return c.json(installBody(await loadTelegramInstall(ctx.projectId)));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/telegram/allowed-users',
      tags: ['channels'],
      summary: 'Allow one Telegram user',
      description: 'Adds the id unless it is listed, and drops its access request. Answers the installation.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        // `{ user_id }`, validated in the handler so every refusal carries a `code`.
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404, 409) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await telegramContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (ctx.response) return ctx.response;
      const userId = ((await c.req.json().catch(() => null)) as { user_id?: unknown } | null)?.user_id;
      if (typeof userId !== 'string' || !TELEGRAM_USER_ID.test(userId)) return invalidUserId(c);
      if (!(await loadTelegramInstall(ctx.projectId))) return notConnected(c);
      if (!(await addTelegramAllowedUser(ctx.projectId, userId))) {
        return c.json(
          { error: `At most ${TELEGRAM_MAX_ALLOWED_USERS} Telegram users can be allowed`, code: 'telegram_allowed_users_full' },
          409,
        );
      }
      return c.json(installBody(await loadTelegramInstall(ctx.projectId)));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/channels/telegram/allowed-users/{user_id}',
      tags: ['channels'],
      summary: 'Remove one allowed Telegram user',
      description: 'Idempotent. Answers the installation.',
      ...auth,
      request: { params: UserParams },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    (c: Context<AppEnv>) => editByUserId(c, removeTelegramAllowedUser),
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/channels/telegram/access-requests/{user_id}',
      tags: ['channels'],
      summary: 'Dismiss one Telegram access request',
      description: 'Idempotent. The user can ask again by messaging the bot. Answers the installation.',
      ...auth,
      request: { params: UserParams },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    (c: Context<AppEnv>) => editByUserId(c, dismissTelegramAccessRequest),
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/channels/telegram',
      tags: ['channels'],
      summary: 'Disconnect the Telegram bot',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(z.object({ ok: z.boolean() }), 'OK'), ...errors(403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await telegramContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (ctx.response) return ctx.response;
      const token = await loadTelegramBotToken(ctx.projectId);
      // Best effort: a revoked token cannot remove its webhook, and the install goes either way.
      if (token) await telegramCall(token, 'deleteWebhook').catch(() => undefined);
      await deleteTelegramInstall(ctx.projectId);
      reconcileInBackground(ctx.projectId);
      return c.json({ ok: true });
    },
  );
}
