/**
 * Pure inbound-side logic for the Telegram channel: update/message types,
 * bot-command parsing, group-chat etiquette (when the bot should respond),
 * and the prompts a telegram-originated session is seeded with. Framework-
 * and DB-free so every rule here is unit-testable.
 */

export interface TelegramChat {
  id: number;
  type: string; // 'private' | 'group' | 'supergroup' | 'channel'
  title?: string;
  username?: string;
}

export interface TelegramUser {
  id?: number;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: { from?: TelegramUser };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

// ─── Bot commands ────────────────────────────────────────────────────────────

export type TelegramCommand = 'start' | 'help' | 'new';

/** The command menu registered with Telegram at connect time (`setMyCommands`)
 *  — what users see when they type `/` in the chat. */
export const TELEGRAM_BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'new', description: 'Start a fresh conversation (new session)' },
  { command: 'help', description: 'What this bot can do and how to use it' },
  { command: 'start', description: 'Introduction and setup status' },
];

/**
 * Parse a leading bot command. Telegram formats commands as `/cmd` or, in
 * groups (where several bots may listen), `/cmd@BotUsername` — a command
 * addressed to a DIFFERENT bot is not ours and returns null. Unknown commands
 * also return null and flow through as a normal message.
 */
export function parseTelegramCommand(
  text: string | undefined,
  botUsername: string | null,
): { command: TelegramCommand; args: string } | null {
  if (!text) return null;
  const m = /^\/([a-zA-Z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const [, raw, addressee, args] = m;
  if (addressee && botUsername && addressee.toLowerCase() !== botUsername.toLowerCase()) {
    return null; // someone else's bot
  }
  const command = raw.toLowerCase();
  if (command !== 'start' && command !== 'help' && command !== 'new') return null;
  return { command, args: (args ?? '').trim() };
}

// ─── Group etiquette ─────────────────────────────────────────────────────────

/**
 * Whether the bot should respond to this message at all.
 *  - Private chats: always (the user is talking to the bot by definition).
 *  - Groups/supergroups: only when @-mentioned or when replying to one of the
 *    bot's own messages — a project bot must not answer every message in a
 *    busy group.
 *  - Channel posts and anything else: never (out of scope).
 * Commands are exempt from the mention rule — `/new` in a group clearly
 * addresses the bot (Telegram's own command UX omits the @ for single-bot
 * groups).
 */
export function shouldRespondInChat(
  message: TelegramMessage,
  botUsername: string | null,
  botId: string | null,
): boolean {
  const type = message.chat.type;
  if (type === 'private') return true;
  if (type !== 'group' && type !== 'supergroup') return false;
  const text = message.text ?? message.caption ?? '';
  if (parseTelegramCommand(text, botUsername)) return true;
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;
  const repliedTo = message.reply_to_message?.from;
  if (repliedTo?.id != null && botId && String(repliedTo.id) === botId) return true;
  return false;
}

/** Drop the bot's own @mention from the text so the agent prompt reads like a
 *  plain request instead of "@KortixBot do the thing". */
export function stripBotMention(text: string, botUsername: string | null): string {
  if (!botUsername) return text.trim();
  const re = new RegExp(`@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

// ─── Command replies ─────────────────────────────────────────────────────────

export const TELEGRAM_HELP_TEXT = [
  'I connect this chat to a Kortix project. Message me and an agent picks the',
  'task up in a real sandbox — I reply here when it has something for you.',
  '',
  'Commands:',
  '/new — start a fresh conversation (the next message opens a new session)',
  '/help — this message',
  '',
  'In groups I only respond when you @mention me or reply to one of my messages.',
].join('\n');

export const TELEGRAM_START_TEXT = [
  "Hi! I'm your Kortix project bot.",
  '',
  'Send me a message and an agent will work on it and reply right here.',
  'Use /help to see what I can do, or /new to start a fresh conversation.',
].join('\n');

export const TELEGRAM_NEW_TEXT =
  'Fresh start — your next message opens a new conversation with the agent.';

// ─── Session prompts ─────────────────────────────────────────────────────────

const TURN_INSTRUCTIONS = [
  'How to work:',
  '- The `telegram` CLI needs **no token** — everything relays through Kortix',
  '  (the bot token stays server-side). The chat shows a live status message.',
  '- Post a short progress checkpoint before each major step:',
  '    telegram step "Reading the incident logs"',
  '  Keep them human and brief — a few per task — but DO post one before',
  '  anything slow (installs, builds, long searches) so the status message',
  '  never sits stale.',
  '- Deliver the final answer with:',
  '    telegram send "…"',
  '  Markdown renders: **bold**, *italic*, `code`, fenced code blocks,',
  '  [links](https://…). Keep it chat-sized — lead with the answer, light',
  '  structure. Long answers are chunked automatically.',
  '- One `telegram send` per turn — it finalizes the live status message.',
  '- Need to ask the user something? Ask it via `telegram send`, then END your',
  '  turn — their reply arrives as a fresh message in this conversation. The',
  '  built-in `question` tool has no answerer in a chat; do not use it.',
  '- Files & metadata: use the `kortix_telegram` executor connector actions',
  '  (send_document by file_id/URL, get_file, get_chat) — also token-free.',
].join('\n');

function senderLabel(from: TelegramUser | undefined): string {
  if (from?.username) return `@${from.username}`;
  if (from?.first_name) return from.first_name;
  if (from?.id != null) return String(from.id);
  return 'unknown';
}

export function renderTelegramAgentPrompt(
  message: TelegramMessage,
  botUsername: string | null,
): string {
  const text = stripBotMention(message.text ?? message.caption ?? '(non-text payload)', botUsername);
  return [
    "You're answering a message from Telegram.",
    '',
    `Chat:        ${message.chat.id} (${message.chat.type}${message.chat.title ? ` — ${message.chat.title}` : ''})`,
    `From:        ${senderLabel(message.from)}`,
    `Message id:  ${message.message_id}`,
    '',
    'Message:',
    text,
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

export function renderTelegramFollowUpPrompt(
  message: TelegramMessage,
  botUsername: string | null,
): string {
  const text = stripBotMention(message.text ?? message.caption ?? '(non-text payload)', botUsername);
  return [
    `New message from ${senderLabel(message.from)} in the same Telegram chat:`,
    '',
    text,
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}
