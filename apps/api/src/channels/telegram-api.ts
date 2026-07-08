/**
 * Minimal Telegram Bot API client — SERVER-SIDE ONLY. The bot token is loaded
 * from encrypted project secrets and used exclusively here (and by the executor
 * gateway); it is never injected into a sandbox, opencode config, or the CLI.
 *
 * Mirrors slack-api.ts's transport discipline: bounded timeout, 429 honored via
 * Telegram's `parameters.retry_after` (a 429 is always safe to retry — the call
 * wasn't processed), 5xx/network retried only for idempotent calls so an
 * ambiguous failure can't duplicate a message.
 *
 * Telegram quirk vs Slack: the token rides in the URL PATH
 * (`/bot<token>/<method>`), not an Authorization header — so URLs must never be
 * logged raw. Every log line here goes through `redactToken`.
 */

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

/** e2e/staging override — lets the ke2e suite point send/read/file calls at a
 *  local stub instead of the real Bot API. Read per-call (not module load) so
 *  tests can set it after import. */
export function telegramApiBase(): string {
  return (process.env.KORTIX_TELEGRAM_API_BASE || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, '');
}

/** Bot tokens look like `<numeric bot id>:<35-ish char secret>` (BotFather).
 *  Enforcing the shape early gives users a crisp error instead of a Telegram
 *  401, and lets us derive the bot id without an API call. */
export function isValidTelegramBotToken(token: string): boolean {
  return /^\d{1,20}:[A-Za-z0-9_-]{30,64}$/.test(token);
}

/** The numeric bot id is the part before the colon. */
export function telegramBotIdFromToken(token: string): string | null {
  const m = /^(\d{1,20}):/.exec(token);
  return m ? m[1] : null;
}

/** Public webhook URL Telegram will POST updates to. `base` is the public API
 *  origin (config.KORTIX_URL or the request origin). */
export function buildTelegramWebhookUrl(base: string, projectId: string): string {
  return `${base.replace(/\/+$/, '')}/v1/webhooks/telegram/${projectId}`;
}

/** Strip the bot token out of anything destined for logs. */
export function redactToken(text: string): string {
  return text.replace(/bot\d{1,20}:[A-Za-z0-9_-]{30,64}/g, 'bot<redacted>');
}

export interface TelegramApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function telegramApiCall<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  opts: { retries?: number; idempotent?: boolean; timeoutMs?: number } = {},
): Promise<TelegramApiResult<T>> {
  const idempotent = opts.idempotent !== false;
  const maxAttempts = Math.max(1, (opts.retries ?? 1) + 1);
  let last: TelegramApiResult<T> = { ok: false, description: 'unknown' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      let data: TelegramApiResult<T>;
      try {
        data = (await res.json()) as TelegramApiResult<T>;
      } catch {
        data = { ok: false, description: `http_${res.status}` };
      }
      if (res.status === 429) {
        // Not processed → always safe to retry. Telegram tells us exactly when.
        const retryAfter = data.parameters?.retry_after ?? attempt;
        last = { ok: false, description: 'ratelimited', error_code: 429, parameters: data.parameters };
        if (attempt < maxAttempts) {
          await sleep(Math.min(retryAfter, 5) * 1000);
          continue;
        }
        return last;
      }
      if (res.status >= 500) {
        last = { ok: false, description: data.description ?? `http_${res.status}`, error_code: res.status };
        // May have been processed — only retry idempotent calls.
        if (idempotent && attempt < maxAttempts) {
          await sleep(attempt * 400);
          continue;
        }
        return last;
      }
      return data;
    } catch (err) {
      last = {
        ok: false,
        description: (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'network_error',
      };
      if (idempotent && attempt < maxAttempts) {
        await sleep(attempt * 400);
        continue;
      }
      return last;
    }
  }
  return last;
}

// ─── Typed wrappers (install flow) ──────────────────────────────────────────

export interface TelegramBotInfo {
  id: number;
  username?: string;
  first_name?: string;
}

/** Validate a bot token with Telegram and learn the bot's identity. */
export async function telegramGetMe(
  token: string,
): Promise<{ ok: true; bot: TelegramBotInfo } | { ok: false; error: string }> {
  const r = await telegramApiCall<TelegramBotInfo>(token, 'getMe', {}, { retries: 1 });
  if (!r.ok || !r.result?.id) {
    return { ok: false, error: r.description ?? 'unknown error' };
  }
  return { ok: true, bot: r.result };
}

/**
 * Point the bot's webhook at us. `allowed_updates` opts into exactly what the
 * channel handles (callback_query is for inline-keyboard approvals); listing
 * them explicitly also re-enables callback_query if a previous webhook config
 * had narrowed the set.
 */
export async function telegramSetWebhook(
  token: string,
  url: string,
  secretToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await telegramApiCall(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
  });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? 'unknown error' };
}

/** Best-effort webhook teardown on disconnect. */
export async function telegramDeleteWebhook(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await telegramApiCall(token, 'deleteWebhook', { drop_pending_updates: false });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? 'unknown error' };
}
