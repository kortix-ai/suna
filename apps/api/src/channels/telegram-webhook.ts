import { createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import { readSecret } from './install-store';
import { emitIntegrationEvent } from '../integrations/event-inbox';
import { loadTelegramInstall } from './telegram/installs';
import { type TelegramUpdate, telegramMessageEvent, telegramPressEvent } from './telegram/session';
import { makeOpenApiApp, json, errors } from '../openapi';
import { bindIntegrationPrincipal } from '../shared/audit-scope';

export const telegramWebhookApp = makeOpenApiApp();

const TELEGRAM_WEBHOOK_SECRET = 'TELEGRAM_WEBHOOK_SECRET';

async function loadTelegramWebhookSecretForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, TELEGRAM_WEBHOOK_SECRET);
}

telegramWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}',
    tags: ['channels'],
    summary: 'Telegram bot webhook (secret-token verified)',
    request: {
      params: z.object({
        // A project id is always a UUID. Without this, a non-UUID path segment
        // reached the projects DB lookup, which threw on the invalid input and
        // surfaced as a 500 to an anonymous caller (pentest 2026-10-22).
        projectId: z.string().uuid(),
      }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), challenge: z.string().optional() }).passthrough(),
        'Accepted',
      ),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const expected = await loadTelegramWebhookSecretForProject(projectId);
    if (!expected) return c.json({ error: 'Not configured' }, 404);

    const presented = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    // Constant-time compare (matches Slack/GitHub webhook verification) so the
    // secret can't be recovered via response-timing differences.
    const presentedBuf = Buffer.from(presented);
    const expectedBuf = Buffer.from(expected);
    if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
      return c.json({ error: 'Invalid secret' }, 401);
    }
    bindIntegrationPrincipal('telegram', { projectId });

    let update: TelegramUpdate;
    try {
      update = (await c.req.json()) as TelegramUpdate;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // Store the update in the event inbox and ack only after the store, so a
    // crash after the ack loses nothing (channels/telegram/session.ts).
    const botId = (await loadTelegramInstall(projectId))?.botId;
    if (botId) {
      const event = telegramMessageEvent(projectId, botId, update) ?? telegramPressEvent(projectId, botId, update);
      if (event) await emitIntegrationEvent(event, { maxAttempts: 4 });
    }
    return c.json({ ok: true });
  },
);
