/** Telegram channel: connect a bot by token, allow senders, disconnect. */
import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { TELEGRAM_TOKEN_PATTERN, type TelegramBot, TelegramApiError, telegramCall } from '../../channels/telegram/api';
import {
  deleteTelegramInstall,
  loadTelegramBotToken,
  loadTelegramInstall,
  saveTelegramInstall,
  setTelegramAllowedUserIds,
  type TelegramInstall,
} from '../../channels/telegram/installs';
import { config } from '../../config';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { PROJECT_ACTIONS } from '../../iam';
import { logger } from '../../lib/logger';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import type { AppEnv } from '../../types';

const UserIds = z.array(z.string().regex(/^\d{1,20}$/)).max(200);

function installBody(install: TelegramInstall | null) {
  if (!install) return null;
  return { bot_id: install.botId, username: install.username, allowed_user_ids: install.allowedUserIds };
}

/** Load the project and check connector-write (unless read-only). */
async function telegramContext(c: Context<AppEnv>, write: boolean) {
  const projectId = c.req.param('projectId') ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };
  if (write) {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  }
  return { response: null, projectId } as const;
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
      const ctx = await telegramContext(c, false);
      if (ctx.response) return ctx.response;
      return c.json(installBody(await loadTelegramInstall(ctx.projectId)));
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
      const ctx = await telegramContext(c, true);
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
          allowed_updates: ['message'],
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
      const ctx = await telegramContext(c, true);
      if (ctx.response) return ctx.response;
      const parsed = UserIds.safeParse(((await c.req.json().catch(() => null)) as { user_ids?: unknown } | null)?.user_ids);
      if (!parsed.success) {
        return c.json({ error: 'user_ids must be numeric Telegram user ids', code: 'telegram_user_ids_invalid' }, 400);
      }
      if (!(await loadTelegramInstall(ctx.projectId))) {
        return c.json({ error: 'Telegram is not connected', code: 'telegram_not_connected' }, 404);
      }
      await setTelegramAllowedUserIds(ctx.projectId, parsed.data);
      return c.json(installBody(await loadTelegramInstall(ctx.projectId)));
    },
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
      const ctx = await telegramContext(c, true);
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
