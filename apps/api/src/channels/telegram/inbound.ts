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

export interface TelegramFileRef {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: { from?: TelegramUser };
  document?: TelegramFileRef;
  /** Telegram sends multiple resolutions — the last is the largest. */
  photo?: TelegramFileRef[];
  video?: TelegramFileRef;
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
}

/** Normalize a message's attachments into promptable lines. Photos collapse to
 *  the largest rendition. */
export function messageAttachments(
  message: TelegramMessage,
): Array<{ kind: string; file: TelegramFileRef }> {
  const out: Array<{ kind: string; file: TelegramFileRef }> = [];
  if (message.document) out.push({ kind: 'document', file: message.document });
  if (message.photo?.length)
    out.push({ kind: 'photo', file: message.photo[message.photo.length - 1] });
  if (message.video) out.push({ kind: 'video', file: message.video });
  if (message.audio) out.push({ kind: 'audio', file: message.audio });
  if (message.voice) out.push({ kind: 'voice', file: message.voice });
  return out;
}

function humanSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return ` (${bytes} B)`;
  if (bytes < 1024 * 1024) return ` (${Math.round(bytes / 1024)} KB)`;
  return ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
}

/** The attachment section of a prompt — file ids + the download hint. Empty
 *  string when the message carries no files. */
export function describeAttachments(message: TelegramMessage): string {
  const files = messageAttachments(message);
  if (files.length === 0) return '';
  const lines = files.map(
    ({ kind, file }) =>
      `- ${kind}${file.file_name ? ` "${file.file_name}"` : ''}${humanSize(file.file_size)} — file_id: ${file.file_id}`,
  );
  return [
    'Attached files:',
    ...lines,
    'Download any of them into your workspace with:',
    '  telegram download --file-id <file_id> --out <path>',
  ].join('\n');
}

/** An inline-keyboard tap. `message` is the message the button was attached to
 *  — Telegram echoes its full `reply_markup` back, which is how we recover the
 *  tapped option's label without any server-side storage. */
export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: {
    message_id: number;
    chat: TelegramChat;
    reply_markup?: {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string; url?: string }>>;
    };
  };
}

/** A change to the bot's own membership in a chat (added/removed/promoted). */
export interface TelegramChatMemberUpdate {
  chat: TelegramChat;
  from?: TelegramUser;
  new_chat_member?: { user?: TelegramUser; status?: string };
  old_chat_member?: { user?: TelegramUser; status?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramChatMemberUpdate;
}

/** True when this membership change is the bot being freshly added to a group
 *  (transitioning into member/administrator from a non-present state). Drives
 *  the one-time group welcome. */
export function botJustAddedToGroup(update: TelegramChatMemberUpdate): boolean {
  const type = update.chat.type;
  if (type !== 'group' && type !== 'supergroup') return false;
  const now = update.new_chat_member?.status;
  const before = update.old_chat_member?.status;
  const present = (s: string | undefined) =>
    s === 'member' || s === 'administrator' || s === 'creator';
  return (now === 'member' || now === 'administrator') && !present(before);
}

// ─── Bot commands ────────────────────────────────────────────────────────────

export type TelegramCommand = 'start' | 'help' | 'new' | 'status' | 'agent' | 'model';

/** Aliases → canonical command, so `/whoami` and `/settings` reach `/status`. */
const TELEGRAM_COMMAND_ALIASES: Record<string, TelegramCommand> = {
  whoami: 'status',
  settings: 'status',
  config: 'status',
};

const TELEGRAM_COMMANDS: ReadonlySet<TelegramCommand> = new Set([
  'start',
  'help',
  'new',
  'status',
  'agent',
  'model',
]);

/** The command menu registered with Telegram at connect time (`setMyCommands`)
 *  — what users see when they type `/` in the chat. */
export const TELEGRAM_BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'new', description: 'Start a fresh conversation (new session)' },
  { command: 'status', description: 'Show the agent, model & settings this chat uses' },
  { command: 'agent', description: 'Choose which agent answers in this chat' },
  { command: 'model', description: 'Choose which model this chat runs on' },
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
  const lowered = raw.toLowerCase();
  const command = TELEGRAM_COMMAND_ALIASES[lowered] ?? (lowered as TelegramCommand);
  if (!TELEGRAM_COMMANDS.has(command)) return null;
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
  return text
    .replace(re, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Command replies ─────────────────────────────────────────────────────────

export const TELEGRAM_HELP_TEXT = [
  'I connect this chat to a Kortix project. Message me and an agent picks the',
  'task up in a real sandbox — I reply here when it has something for you.',
  '',
  'Commands:',
  '/new — start a fresh conversation (the next message opens a new session)',
  '/status — show the agent, model & settings this chat uses',
  '/agent — choose which agent answers here',
  '/model — choose which model this chat runs on',
  '/help — this message',
  '',
  'In groups I only respond when you @mention me or reply to one of my messages.',
].join('\n');

const TELEGRAM_POLICY_LABELS: Record<string, string> = {
  project_open: 'open to everyone in this chat',
  restricted: 'restricted to approved participants',
};

function escapeStatusValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface TelegramStatusInfo {
  botUsername: string | null;
  projectName: string | null;
  /** null = the project's default agent. */
  agentName: string | null;
  /** null = the project's default model. */
  model: string | null;
  conversationPolicy: string | null;
  pairedUserCount: number;
  /** getMe.can_read_all_group_messages — false means Telegram privacy mode
   *  hides plain @mentions in groups from this bot; null = unknown (getMe
   *  unavailable), which omits the line rather than warning wrongly. */
  groupMentionsEnabled: boolean | null;
}

/** `/status` — the chat's effective routing at a glance (project, agent, model,
 *  reply policy). All values escaped; rendered as Telegram HTML. */
export function renderTelegramStatus(info: TelegramStatusInfo): string {
  const model = info.model ? info.model.split('/').pop() || info.model : 'project default';
  const policy = info.conversationPolicy
    ? (TELEGRAM_POLICY_LABELS[info.conversationPolicy] ?? info.conversationPolicy)
    : 'open to everyone in this chat';
  const lines = [
    '<b>This chat</b>',
    '',
    `<b>Project:</b> ${escapeStatusValue(info.projectName ?? '—')}`,
    `<b>Agent:</b> ${escapeStatusValue(info.agentName ?? 'default')}`,
    `<b>Model:</b> ${escapeStatusValue(model)}`,
    `<b>Replies:</b> ${escapeStatusValue(policy)}`,
  ];
  if (info.groupMentionsEnabled === false) {
    lines.push(
      '<b>Mentions:</b> hidden in groups — privacy mode is on. Fix: @BotFather → /setprivacy → Disable, then re-add me to the group.',
    );
  } else if (info.groupMentionsEnabled === true) {
    lines.push('<b>Mentions:</b> visible in groups');
  }
  if (info.botUsername) {
    lines.push(
      '',
      `<i>@${escapeStatusValue(info.botUsername)} · ${info.pairedUserCount} paired</i>`,
    );
  }
  lines.push('', 'Change with /agent or /model. /new starts a fresh conversation.');
  return lines.join('\n');
}

export const TELEGRAM_START_TEXT = [
  "Hi! I'm your Kortix project bot.",
  '',
  'Send me a message and an agent will work on it and reply right here.',
  'Use /help to see what I can do, or /new to start a fresh conversation.',
].join('\n');

export const TELEGRAM_NEW_TEXT =
  'Fresh start — your next message opens a new conversation with the agent.';

export const TELEGRAM_GROUP_WELCOME_TEXT = [
  '👋 Thanks for adding me! I connect this group to a Kortix project.',
  '',
  'In groups I stay quiet until you need me — @mention me or reply to one of my',
  'messages and an agent picks the task up, then answers right here.',
  '',
  '/help for what I can do · /status for this chat’s agent & model.',
].join('\n');

// Telegram's default bot privacy mode hides plain-text group messages —
// including @mentions — from the bot entirely (only commands, replies and
// service messages are delivered), so the standard welcome would promise a
// flow that can never fire. This variant keeps the paths that DO work up
// front and gives the owner the exact fix.
export const TELEGRAM_GROUP_WELCOME_PRIVACY_TEXT = [
  '👋 Thanks for adding me! I connect this group to a Kortix project.',
  '',
  'In groups I stay quiet until you need me — reply to one of my messages or',
  'use a /command (like /new) and an agent picks the task up.',
  '',
  "⚠️ I can't see @mentions yet — this bot's Telegram privacy mode is on.",
  'To enable mentions: @BotFather → /setprivacy → Disable, then remove and',
  're-add me to this group.',
  '',
  '/help for what I can do · /status for this chat’s agent & model.',
].join('\n');

/** Pick the group welcome matching the bot's live privacy setting. `null`
 *  (getMe unavailable) falls back to the standard text rather than warning
 *  about a privacy mode we couldn't confirm. */
export function telegramGroupWelcomeText(groupMentionsEnabled: boolean | null): string {
  return groupMentionsEnabled === false
    ? TELEGRAM_GROUP_WELCOME_PRIVACY_TEXT
    : TELEGRAM_GROUP_WELCOME_TEXT;
}

export const TELEGRAM_PAIRED_TEXT = [
  "✅ Paired! You're on this project's allowlist now.",
  '',
  'Send me a message and an agent will work on it and reply right here.',
  'Use /help to see what I can do, or /new to start a fresh conversation.',
].join('\n');

export const TELEGRAM_PAIRING_FAILED_TEXT = [
  "That pairing code didn't work — it may have expired (codes last 15 minutes)",
  'or already been used. Ask a project admin to generate a fresh one',
  '(dashboard → Customize → Channels → Telegram → Pair), then send:',
  '/start <code>',
].join('\n');

export const TELEGRAM_LOCKED_TEXT = [
  'This bot only talks to paired users.',
  '',
  'Ask a project admin for a pairing code (dashboard → Customize → Channels →',
  'Telegram → Pair), then send: /start <code>',
].join('\n');

// ─── Session prompts ─────────────────────────────────────────────────────────

const TURN_INSTRUCTIONS = [
  'How to work:',
  '- The `telegram` CLI needs **no token** — everything relays through Kortix',
  "  (the bot token stays server-side). While you work, the user's message shows",
  '  a 🤔 reaction and a typing cue — no progress messages are posted, so the',
  '  chat stays clean until you answer.',
  '- Deliver the final answer with:',
  '    telegram send "…"',
  '  It posts as a single reply (🤔 flips to 👍). Markdown renders: **bold**,',
  '  *italic*, `code`, fenced code blocks, [links](https://…). Keep it chat-sized',
  '  — lead with the answer, light structure. Long answers are chunked',
  '  automatically. Send exactly ONE `telegram send` per turn.',
  '- `telegram step "…"` is optional and NOT shown in the chat (it only keeps the',
  '  typing cue alive on a long turn) — you never need to post progress.',
  '- Need to ask the user something with a few fixed choices? Use the built-in',
  '  `question` tool — its options render as tappable buttons in the chat. The',
  "  user's tap (or a typed reply) arrives as a fresh message, so END your turn",
  '  after asking; do not wait. For open-ended questions, just `telegram send`',
  '  the question and end the turn.',
  '- Files: `telegram download --file-id <id> --out <path>` pulls a received',
  '  file into your workspace; `telegram send --file <path> [--caption "…"]`',
  '  sends a workspace file to the chat. Both are token-free (server-side',
  '  proxy). Chat metadata: the `kortix_telegram` executor connector',
  '  (get_chat, get_file, send_document by file_id/URL).',
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
  const text = stripBotMention(
    message.text ?? message.caption ?? '(non-text payload)',
    botUsername,
  );
  const attachments = describeAttachments(message);
  return [
    "You're answering a message from Telegram.",
    '',
    `Chat:        ${message.chat.id} (${message.chat.type}${message.chat.title ? ` — ${message.chat.title}` : ''})`,
    `From:        ${senderLabel(message.from)}`,
    `Message id:  ${message.message_id}`,
    '',
    'Message:',
    text,
    ...(attachments ? ['', attachments] : []),
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

export function renderTelegramFollowUpPrompt(
  message: TelegramMessage,
  botUsername: string | null,
): string {
  const text = stripBotMention(
    message.text ?? message.caption ?? '(non-text payload)',
    botUsername,
  );
  const attachments = describeAttachments(message);
  return [
    `New message from ${senderLabel(message.from)} in the same Telegram chat:`,
    '',
    text,
    ...(attachments ? ['', attachments] : []),
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}
