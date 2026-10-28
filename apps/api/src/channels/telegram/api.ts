/**
 * Minimal Telegram Bot API client for the server side of the channel: install
 * (getMe, setWebhook, getWebhookInfo, deleteWebhook), the pairing/typing
 * replies, and the agent's questions (sendMessage with buttons, then
 * answerCallbackQuery and the edit on a press), and the allowed users' names
 * and photos (getChat, getFile and the file download). Agent-sent
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

const apiBase = () => config.TELEGRAM_API_URL.replace(/\/+$/, '');

export async function telegramCall<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TelegramApiError(method, 0, error instanceof Error ? error.name : 'network error');
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !data?.ok) throw new TelegramApiError(method, res.status, data?.description ?? 'no response');
  return data.result as T;
}

/** Telegram could not answer: no connection, a timeout, a rate limit or a 5xx. Anything else is a refusal. */
export function telegramUnreachable(error: unknown): boolean {
  return !(error instanceof TelegramApiError) || error.status === 0 || error.status === 429 || error.status >= 500;
}

/** A file from `getFile`, at most `maxBytes`. Its URL carries the token, so no error names it. */
export async function telegramDownload(
  token: string,
  filePath: string,
  maxBytes: number,
  timeoutMs = 5_000,
): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new TelegramApiError('download', 0, error instanceof Error ? error.name : 'network error');
  }
  if (!res.ok) throw new TelegramApiError('download', res.status, 'no file');
  const tooLarge = () => new TelegramApiError('download', 413, 'file too large');
  if (Number(res.headers.get('content-length')) > maxBytes) throw tooLarge();
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw tooLarge();
  return bytes;
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
