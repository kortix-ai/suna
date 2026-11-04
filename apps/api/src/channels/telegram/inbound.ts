/**
 * Telegram's adapter for the shared webhook route (channels/inbound), mounted
 * at `/v1/webhooks/telegram/{projectId}`, the URL connect registers at Telegram.
 * Importing ./session also registers the `telegram.` event consumer: without
 * it the stored updates have no handler.
 */
import { type ChannelInbound, safeEqual } from '../inbound/inbound';
import { loadTelegramInstall, loadTelegramWebhookSecret } from './installs';
import { type TelegramUpdate, telegramMessageEvent, telegramPressEvent } from './session';

export const telegramInbound: ChannelInbound<{ projectId: string }> = {
  platform: 'telegram',
  summary: 'Telegram bot webhook (secret-token verified)',
  maxAttempts: 4,
  async verify({ projectId, header }) {
    const expected = await loadTelegramWebhookSecret(projectId);
    if (!expected) return { status: 404, body: { error: 'Not configured' } };
    if (!safeEqual(header('x-telegram-bot-api-secret-token') ?? '', expected)) {
      return { status: 401, body: { error: 'Invalid secret' } };
    }
    return { verified: { projectId } };
  },
  // A deleted project keeps its install row but loads none, so its updates are acked and dropped.
  async normalize(body, { projectId }) {
    const botId = (await loadTelegramInstall(projectId))?.botId;
    if (!botId) return { events: [] };
    const update = body as TelegramUpdate;
    const event = telegramMessageEvent(projectId, botId, update) ?? telegramPressEvent(projectId, botId, update);
    return { events: event ? [event] : [] };
  },
};
