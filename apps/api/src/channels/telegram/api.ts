/**
 * Minimal Telegram Bot API client for the server side of the channel: install
 * (getMe, setWebhook, getWebhookInfo, deleteWebhook), the pairing/typing
 * replies, and the agent's questions (sendMessage with buttons, then
 * answerCallbackQuery and the edit on a press). Agent-sent
 * messages go through the `kortix_telegram` connector instead (connectors/channels.ts).
 */
import { config } from '../../config';

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description: string,
  ) {
    // Never include the URL: it carries the bot token.
    super(`telegram ${method} failed (${status}): ${description}`);
  }
}

export async function telegramCall<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.TELEGRAM_API_URL.replace(/\/+$/, '')}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new TelegramApiError(method, 0, error instanceof Error ? error.name : 'network error');
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !data?.ok) throw new TelegramApiError(method, res.status, data?.description ?? 'no response');
  return data.result as T;
}

export interface TelegramBot {
  id: number;
  username?: string;
  first_name?: string;
}

/** The updates the webhook receives: messages, and presses on question buttons. */
export const TELEGRAM_UPDATES = ['message', 'callback_query'];

/** A bot token is `<bot id>:<secret>`; anything else never reaches the network. */
export const TELEGRAM_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
