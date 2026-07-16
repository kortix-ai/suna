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
        last = {
          ok: false,
          description: 'ratelimited',
          error_code: 429,
          parameters: data.parameters,
        };
        if (attempt < maxAttempts) {
          await sleep(Math.min(retryAfter, 5) * 1000);
          continue;
        }
        return last;
      }
      if (res.status >= 500) {
        last = {
          ok: false,
          description: data.description ?? `http_${res.status}`,
          error_code: res.status,
        };
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
  /** True when BotFather privacy mode is DISABLED — only then does Telegram
   *  deliver plain-text group messages (incl. @mentions) to the bot. With
   *  privacy ON, groups deliver just commands, replies and service messages. */
  can_read_all_group_messages?: boolean;
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

// ─── User cards (dashboard pairing list) ────────────────────────────────────

interface TelegramChatInfo {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo?: { small_file_id?: string };
}

/** One paired sender's display info: name/@username, plus a self-contained
 *  avatar `data:` URI when photos were requested (bearer-auth API means the
 *  browser can't fetch a Telegram file URL itself). */
export interface TelegramUserCard {
  firstName?: string;
  lastName?: string;
  username?: string;
  /** Avatar data URI, or null when the user has no photo / it couldn't be
   *  fetched. Undefined when photos weren't requested. */
  photo?: string | null;
}

/** getChat on a user id returns the user's profile (name, @username, photo
 *  file ids) for anyone who has started the bot — which every paired sender
 *  has. Best-effort: returns null on any failure so a Telegram hiccup never
 *  breaks the dashboard read. */
async function telegramGetChatInfo(token: string, chatId: string): Promise<TelegramChatInfo | null> {
  const r = await telegramApiCall<TelegramChatInfo>(
    token,
    'getChat',
    { chat_id: chatId },
    { retries: 0, timeoutMs: 4000 },
  );
  return r.ok && r.result?.id ? r.result : null;
}

/** Resolve a Telegram file_id to a downloadable path, then fetch the bytes as a
 *  base64 `data:` URI. Small profile photos are ~5–15 KB; anything over 256 KB
 *  is dropped (a sanity cap — profile thumbnails are tiny). */
async function telegramFileDataUri(token: string, fileId: string): Promise<string | null> {
  const r = await telegramApiCall<{ file_path?: string }>(
    token,
    'getFile',
    { file_id: fileId },
    { retries: 0, timeoutMs: 4000 },
  );
  const filePath = r.ok ? r.result?.file_path : undefined;
  if (!filePath) return null;
  const res = await fetch(`${telegramApiBase()}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 256 * 1024) return null;
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

/** Fetch a paired user's display card (one getChat), optionally with the avatar
 *  downloaded and inlined. All best-effort — returns null if getChat fails. */
export async function telegramFetchUserCard(
  token: string,
  chatId: string,
  opts: { withPhoto?: boolean } = {},
): Promise<TelegramUserCard | null> {
  const chat = await telegramGetChatInfo(token, chatId);
  if (!chat) return null;
  const card: TelegramUserCard = {
    firstName: chat.first_name,
    lastName: chat.last_name,
    username: chat.username,
  };
  if (opts.withPhoto) {
    card.photo = chat.photo?.small_file_id
      ? await telegramFileDataUri(token, chat.photo.small_file_id)
      : null;
  }
  return card;
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
    allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
  });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? 'unknown error' };
}

export interface TelegramWebhookInfo {
  url: string;
  pending_update_count?: number;
  last_error_message?: string;
}

/** What webhook Telegram currently has registered for this bot (used to skip a
 *  redundant setWebhook when the URL is already correct). Null on failure. */
export async function telegramGetWebhookInfo(token: string): Promise<TelegramWebhookInfo | null> {
  const r = await telegramApiCall<TelegramWebhookInfo>(token, 'getWebhookInfo', {}, { retries: 1 });
  return r.ok && r.result ? r.result : null;
}

/** Best-effort webhook teardown on disconnect. */
export async function telegramDeleteWebhook(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await telegramApiCall(token, 'deleteWebhook', { drop_pending_updates: false });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? 'unknown error' };
}

/** Register the bot's `/` command menu (shown by Telegram's command UI). */
export async function telegramSetMyCommands(
  token: string,
  commands: ReadonlyArray<{ command: string; description: string }>,
): Promise<{ ok: boolean; error?: string }> {
  const r = await telegramApiCall(token, 'setMyCommands', { commands });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? 'unknown error' };
}

/**
 * Send a plain message. A WRITE — ambiguous 5xx/timeouts are not retried so a
 * slow success can't become a duplicate (429 still retries; it wasn't
 * processed). Returns the new message id, or null on failure.
 */
/** An inline-keyboard button. Exactly one of `url` (opens a link) or
 *  `callbackData` (posts a callback_query back to the webhook) is set. */
export interface TelegramInlineButton {
  text: string;
  url?: string;
  callbackData?: string;
}

export interface TelegramSendOptions {
  replyToMessageId?: number;
  parseMode?: 'HTML';
  /** One row of buttons under the message (e.g. "Open in Kortix"). */
  buttons?: TelegramInlineButton[];
  /** Explicit multi-row keyboard (e.g. one question option per row). Takes
   *  precedence over `buttons`. */
  keyboard?: TelegramInlineButton[][];
  disableWebPagePreview?: boolean;
}

function serializeButton(b: TelegramInlineButton): Record<string, string> {
  if (b.url != null) return { text: b.text, url: b.url };
  if (b.callbackData != null) return { text: b.text, callback_data: b.callbackData };
  return { text: b.text };
}

/** Build the `reply_markup.inline_keyboard` rows from either an explicit
 *  multi-row `keyboard` or a single `buttons` row. Undefined when neither is set
 *  (so we omit reply_markup rather than send an empty keyboard). */
export function inlineKeyboardMarkup(
  opts: Pick<TelegramSendOptions, 'buttons' | 'keyboard'>,
): { inline_keyboard: Record<string, string>[][] } | undefined {
  const rows = opts.keyboard ?? (opts.buttons?.length ? [opts.buttons] : undefined);
  if (!rows?.length) return undefined;
  return { inline_keyboard: rows.map((row) => row.map(serializeButton)) };
}

function sendPayload(chatId: number | string, text: string, opts: TelegramSendOptions) {
  const markup = inlineKeyboardMarkup(opts);
  return {
    chat_id: chatId,
    text,
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    ...(opts.replyToMessageId
      ? {
          reply_parameters: {
            message_id: opts.replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
    ...(markup ? { reply_markup: markup } : {}),
    ...(opts.disableWebPagePreview ? { link_preview_options: { is_disabled: true } } : {}),
  };
}

export async function telegramSendMessage(
  token: string,
  chatId: number | string,
  text: string,
  opts: TelegramSendOptions = {},
): Promise<number | null> {
  const r = await telegramApiCall<{ message_id?: number }>(
    token,
    'sendMessage',
    sendPayload(chatId, text, opts),
    { idempotent: false },
  );
  if (!r.ok) {
    console.warn('[telegram-api] sendMessage failed', {
      error: redactToken(r.description ?? 'unknown'),
    });
    return null;
  }
  return typeof r.result?.message_id === 'number' ? r.result.message_id : null;
}

/**
 * Edit a message the bot sent — the live-status repaint primitive. Edits are
 * idempotent, so ambiguous failures retry freely. Telegram answers 400
 * "message is not modified" when the text is unchanged — treated as success.
 */
export async function telegramEditMessageText(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  opts: Pick<
    TelegramSendOptions,
    'parseMode' | 'buttons' | 'keyboard' | 'disableWebPagePreview'
  > = {},
): Promise<boolean> {
  const markup = inlineKeyboardMarkup(opts);
  const r = await telegramApiCall(
    token,
    'editMessageText',
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(markup ? { reply_markup: markup } : {}),
      ...(opts.disableWebPagePreview ? { link_preview_options: { is_disabled: true } } : {}),
    },
    { retries: 1 },
  );
  if (r.ok) return true;
  if ((r.description ?? '').includes('message is not modified')) return true;
  console.warn('[telegram-api] editMessageText failed', {
    error: redactToken(r.description ?? 'unknown'),
  });
  return false;
}

/**
 * Acknowledge an inline-keyboard tap — stops the button's spinner and (with
 * `text`) shows a small toast to the tapper. Best-effort: a failed ack only
 * leaves a spinner, never blocks the answer routing. `callback_query.id`s expire
 * quickly, so this is idempotent-ish and never retried aggressively.
 */
export async function telegramAnswerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await telegramApiCall(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text: text.slice(0, 200) } : {}),
  }).catch(() => {});
}

/** Fire-and-forget liveness cue ("typing…" for ~5s). Never throws. */
export async function telegramSendChatAction(
  token: string,
  chatId: number | string,
  action = 'typing',
): Promise<void> {
  await telegramApiCall(token, 'sendChatAction', { chat_id: chatId, action }).catch(() => {});
}

/** Body for setMessageReaction: `emoji` sets a single reaction (replacing any
 *  previous — Telegram reactions are a SET, so 👀→👍 needs no explicit clear);
 *  `null` clears the reaction. Only the standard reaction emoji are accepted by
 *  Telegram (👀 and 👍 both are). */
export function setMessageReactionPayload(
  chatId: number | string,
  messageId: number,
  emoji: string | null,
): Record<string, unknown> {
  return {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: 'emoji', emoji }] : [],
  };
}

/** Replace ONLY a message's inline keyboard (leaves the text) — the checkbox
 *  repaint for multi-select toggles. `null` clears the keyboard. Edits are
 *  idempotent; "message is not modified" is treated as success. */
export async function telegramEditMessageReplyMarkup(
  token: string,
  chatId: number | string,
  messageId: number,
  keyboard: TelegramInlineButton[][] | null,
): Promise<boolean> {
  const markup = keyboard ? inlineKeyboardMarkup({ keyboard }) : { inline_keyboard: [] };
  const r = await telegramApiCall(
    token,
    'editMessageReplyMarkup',
    { chat_id: chatId, message_id: messageId, reply_markup: markup },
    { retries: 1 },
  );
  if (r.ok) return true;
  if ((r.description ?? '').includes('message is not modified')) return true;
  return false;
}

/** React to a message (the user's, as a liveness cue). Best-effort — a rejected
 *  reaction (unsupported emoji, message too old, no rights) is swallowed. */
export async function telegramSetMessageReaction(
  token: string,
  chatId: number | string,
  messageId: number,
  emoji: string | null,
): Promise<void> {
  await telegramApiCall(
    token,
    'setMessageReaction',
    setMessageReactionPayload(chatId, messageId, emoji),
  ).catch(() => {});
}
