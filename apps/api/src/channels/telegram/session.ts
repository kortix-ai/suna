/**
 * Telegram as a channel connector. The webhook stores each
 * update in the integration event inbox; this consumer turns a stored message
 * into a session turn through the conversation core (channels/core/conversation.ts):
 *
 *   unknown sender  → a pairing reply naming their user id, no session (fail closed);
 *                     in a private chat, also an access request an admin can allow
 *   a command       → `/help` (`/start`), `/status`, `/new`, `/stop`, `/model`, `/agent`,
 *                     also as `/<verb>@<this bot>` and as a caption, run in the core
 *                     (core/commands.ts) and answered in the chat, with a menu of
 *                     buttons where the reply offers one; a caption's file is not read
 *   anything else   → the core: a follow-up into the chat's session, or a new
 *                     project-visible session bound to the chat; the message's own
 *                     file (photo, document, audio, voice, video) goes with it
 *   a button press  → a command button (`kc:`) runs its command over the pressed
 *                     message (core/commands.ts `runCommandPress`); a question button
 *                     answers the agent's question (core/questions.ts)
 *
 * The agent answers through the `kortix_telegram` connector (connectors/channels.ts);
 * the bot token never enters the sandbox.
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { chatThreads, projects } from '@kortix/db';
import { type ChannelEnvelope, channelPromptText } from '@kortix/shared';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { and, eq, like, or } from 'drizzle-orm';
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { db } from '../../shared/db';
import { TELEGRAM_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { gateSender, refusedPressText } from '../core/channel-access';
import { CHANNEL_COMMANDS, parseChannelCommand } from '../core/command-list';
import { type CommandPress, isCommandPressData, pressData } from '../core/command-press';
import { type CommandReply, runChannelCommand, runCommandPress } from '../core/commands';
import { type ChannelNotice, type ChannelPort, type ChannelTarget, routeChannelMessage } from '../core/conversation';
import { chatSessionStart, chatTurnModel } from '../core/model-choice';
import { connectorReply } from '../core/prompt';
import {
  clearQuestionButtons,
  handleQuestionTap,
  type QuestionFooter,
  type QuestionMessage,
  type QuestionPort,
} from '../core/questions';
import { registerSessionPort } from '../core/session-notice';
import type { SettingsChannel } from '../core/settings';
import { claimThreadCreate, releaseThreadCreate } from '../core/threads';
import { classifyTurnError } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { startErrorMessage, TELEGRAM_START_ERROR_COMMANDS } from '../start-error';
import { telegramAccessPort } from './access';
import { TELEGRAM_UPDATES, telegramCall, telegramFile } from './api';
import { loadTelegramBotToken, loadTelegramInstall, loadTelegramWebhookSecret } from './installs';
import { repairTelegramMenu } from './menu';

export const TELEGRAM_MESSAGE_EVENT = 'telegram.message.created';

/** A file a message carries: the id `getFile` takes, and what Telegram states about it. */
interface TelegramFileRef { file_id: string; file_size?: number; file_name?: string; mime_type?: string; duration?: number }

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id?: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  photo?: Array<TelegramFileRef & { width: number; height: number }>;
  /** Also set for an animation, so an animation is read once, as this. */
  document?: TelegramFileRef;
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
  video?: TelegramFileRef;
  video_note?: TelegramFileRef;
  sticker?: { emoji?: string };
  media_group_id?: string;
}

/** Each kind of file, in the order read: Kortix's word for it (also the session-view label) and the type Telegram leaves out. */
const TELEGRAM_FILE_KINDS = [
  { kind: 'photo', noun: 'photo', mime: 'image/jpeg' },
  { kind: 'document', noun: 'document', mime: 'application/octet-stream' },
  { kind: 'audio', noun: 'audio', mime: 'audio/mpeg' },
  { kind: 'voice', noun: 'voice message', mime: 'audio/ogg' },
  { kind: 'video', noun: 'video', mime: 'video/mp4' },
  { kind: 'video_note', noun: 'video message', mime: 'video/mp4' },
] as const;

/**
 * The message's own file, never a quoted message's (`reply_to_message`). A photo comes in several
 * sizes: the largest by area, since the Bot API does not state their order. Null: no file.
 */
export function telegramFileOf(
  message: TelegramMessage,
): { ref: TelegramFileRef; kind: string; name?: string; mime: string; label: string } | null {
  for (const k of TELEGRAM_FILE_KINDS) {
    const value = message[k.kind];
    const ref = Array.isArray(value)
      ? value.reduce<(typeof value)[number] | undefined>((best, size) => (!best || size.width * size.height > best.width * best.height ? size : best), undefined)
      : value;
    if (!ref?.file_id) continue;
    const label = k.kind === 'document' && ref.file_name ? `file ${ref.file_name}`
      : ref.duration && (k.kind === 'voice' || k.kind === 'video_note') ? `${k.noun}, ${ref.duration} s`
      : k.noun;
    return { ref, kind: k.noun, ...(ref.file_name ? { name: ref.file_name } : {}), mime: ref.mime_type || k.mime, label };
  }
  return null;
}

/**
 * The sender's words: the text, else the caption, else a label for the file or sticker. A named file keeps
 * its label under a caption, so its name reaches the agent in the sender's own (untrusted) text.
 */
function telegramText(message: TelegramMessage): string {
  if (message.text !== undefined) return message.text;
  const file = telegramFileOf(message);
  if (message.caption !== undefined) return file?.name ? `${message.caption}\n(${file.label})` : message.caption;
  if (file) return `(${file.label})`;
  if (message.sticker) return message.sticker.emoji ? `(sticker ${message.sticker.emoji})` : '(sticker)';
  return '(no text)';
}

/** A tap on an inline button. */
export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  /** The message with the button. Absent for an inline-mode message, which Kortix never sends. */
  message?: Pick<TelegramMessage, 'message_id' | 'chat' | 'message_thread_id' | 'is_topic_message'>;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** A forum topic is its own conversation; otherwise the whole chat is one. */
export function telegramThreadId(message: TelegramMessage): string {
  return message.is_topic_message && message.message_thread_id
    ? `${message.chat.id}:${message.message_thread_id}`
    : String(message.chat.id);
}

/**
 * The inbox envelope for an update, or null when it carries nothing to answer. Edits are skipped, and so
 * is a message with no text, caption, file or sticker: a join, a pin, a location, a contact or a poll.
 */
export function telegramMessageEvent(
  projectId: string,
  botId: string,
  update: TelegramUpdate,
): IntegrationEvent | null {
  const message = update.message;
  if (!message?.chat || message.from?.is_bot) return null;
  if (message.text === undefined && message.caption === undefined && !message.sticker && !telegramFileOf(message)) return null;
  return {
    id: String(update.update_id),
    source: `telegram:${botId}`,
    type: TELEGRAM_MESSAGE_EVENT,
    time: new Date((message.date ?? Date.now() / 1000) * 1000).toISOString(),
    subject: telegramThreadId(message),
    projectId,
    data: { message: message as unknown as Record<string, unknown> },
  };
}

export const TELEGRAM_PRESS_EVENT = 'telegram.callback_query.created';

/** The inbox envelope for a button press, or null for an update without one. */
export function telegramPressEvent(projectId: string, botId: string, update: TelegramUpdate): IntegrationEvent | null {
  const press = update.callback_query;
  if (!press?.id || !press.from) return null;
  const message = press.message;
  const stored: TelegramCallbackQuery = {
    id: press.id,
    from: { id: press.from.id, ...(press.from.username ? { username: press.from.username } : {}) },
    ...(press.data ? { data: press.data } : {}),
    ...(message
      ? {
          message: {
            message_id: message.message_id,
            chat: { id: message.chat.id, type: message.chat.type },
            ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
            ...(message.is_topic_message ? { is_topic_message: true } : {}),
          },
        }
      : {}),
  };
  return {
    id: String(update.update_id),
    source: `telegram:${botId}`,
    type: TELEGRAM_PRESS_EVENT,
    time: new Date().toISOString(),
    subject: message ? String(message.chat.id) : null,
    projectId,
    // Only what the press handler reads: no names, no question text.
    data: { callback_query: stored as unknown as Record<string, unknown> },
  };
}

/** One tap per option up to this many (Teams parity, teams/cards.ts); more is a numbered list. */
const MAX_BUTTONS = CHANNELS.telegram.buttons.max;
/** 3900: of the 4096 characters a message holds, the footer gets 190, the blank line 2, and 4 stay spare. */
const QUESTION_BODY_MAX = CHANNELS.telegram.messageChars - 196;
/** A tap on a question nothing can answer any more: its session is gone, or the chat moved on. */
const EARLIER_QUESTION = 'This question is from an earlier conversation. Send your answer as a message.';

/** At most `max` UTF-16 units, never half an emoji: Telegram refuses a lone surrogate. */
function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Questions as chat text: each question with its numbered options, then the footer. */
export function telegramQuestionText(questions: RuntimeQuestion[], footer: string): string {
  const body = questions
    .map((q, i) =>
      [
        `${questions.length > 1 ? `${i + 1}) ` : ''}${q.header ? `${q.header}: ` : ''}${q.question}${q.multiple ? ' (pick one or more)' : ''}`,
        ...q.options.map((o, j) => `${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`),
      ].join('\n'),
    )
    .join('\n\n');
  return `${clip(body, QUESTION_BODY_MAX)}\n\n${clip(footer, 190)}`;
}

/** A question message's last line; a tap's toast uses the same words. */
function questionFooter(footer: QuestionFooter): string {
  switch (footer.kind) {
    case 'ask':
      return footer.buttons
        ? 'Tap an option, or reply to this message with your own answer.'
        : `Reply to this message with your answer${footer.numbered ? ', each question by its number' : ''}.`;
    case 'answered':
      return `Answered: ${footer.label}`;
    case 'answered_in_chat':
      return 'Answered in the chat.';
    case 'new_conversation':
      return 'A new conversation started.';
    case 'earlier':
      return EARLIER_QUESTION;
  }
}

const questionMessageText = (m: QuestionMessage) =>
  m.questions.length ? telegramQuestionText(m.questions, questionFooter(m.footer)) : questionFooter(m.footer);

const inlineKeyboard = (m: QuestionMessage) => (m.buttons ?? []).map((b) => [{ text: clip(b.label, 60), callback_data: b.data }]);

/** The question as the agent would send it with `send_message`. */
function questionBody(target: ChannelTarget, m: QuestionMessage): Record<string, unknown> {
  const [chatId, topicId] = target.threadId.split(':');
  return {
    // A string, as the agent sends it, so a policy condition on it decides as it would for the agent.
    chat_id: chatId,
    text: questionMessageText(m),
    ...(topicId ? { message_thread_id: Number(topicId) } : {}),
    ...(m.buttons ? { reply_markup: { inline_keyboard: inlineKeyboard(m) } } : {}),
  };
}

/** Telegram shows a spinner until a press is answered. Never throws. */
function answerPress(token: string, id: string, text = '', alert = false): Promise<unknown> {
  return telegramCall(token, 'answerCallbackQuery', {
    callback_query_id: id,
    ...(text ? { text: clip(text, 200) } : {}),
    ...(alert ? { show_alert: true } : {}),
  }).catch(() => undefined);
}

async function botToken(projectId: string): Promise<string> {
  const token = await loadTelegramBotToken(projectId);
  if (!token) throw new Error('telegram bot token missing');
  return token;
}

/**
 * The agent's questions (core/questions.ts), posted as the agent would post
 * them with `send_message`. A bot that cannot take presses gets a numbered list
 * to reply to. A message ref is the Telegram message id.
 */
const telegramQuestions: QuestionPort = {
  maxButtons: MAX_BUTTONS,
  agentCall: (target, m) => ({ slug: TELEGRAM_CHANNEL_CONNECTOR_SLUG, actionPath: 'send_message', args: questionBody(target, m) }),
  async tapsReady(target) {
    const token = await loadTelegramBotToken(target.projectId);
    return !!token && subscribeToButtons(token, target.projectId);
  },
  async send(target, m) {
    const sent = await telegramCall<{ message_id: number }>(await botToken(target.projectId), 'sendMessage', questionBody(target, m));
    return String(sent.message_id);
  },
  async edit(target, ref, m) {
    // A number, as every reply sends it: only the post stands in for the agent's call.
    const message = { chat_id: Number(target.threadId.split(':')[0]), message_id: Number(ref) };
    const token = await botToken(target.projectId);
    await (m
      ? telegramCall(token, 'editMessageText', { ...message, text: questionMessageText(m), reply_markup: { inline_keyboard: inlineKeyboard(m) } })
      : telegramCall(token, 'editMessageReplyMarkup', { ...message, reply_markup: { inline_keyboard: [] } }));
  },
  async answerTap(tap, reply) {
    const token = await loadTelegramBotToken(tap.target.projectId).catch(() => null);
    if (token) await answerPress(token, tap.id, reply && questionFooter(reply));
  },
  threadOfTap: (tap, sessionId) => telegramThreadOfSession(sessionId, tap.target.workspaceId, tap.target.threadId.split(':')[0]!),
};

/** Plain-text next step per `classifyTurnError` title (slack/errors.ts). Another title ('Run failed') gets the fallback. */
const RUN_ERROR_ADVICE: Partial<Record<string, string>> = {
  'Out of credits': 'A workspace admin can top up credits in Kortix. Then send your message again.',
  'Usage limit reached': 'Wait, then send your message again. A project admin can also pick another model in Kortix.',
  'Response too long': 'Ask the agent to continue, or narrow the request.',
  'Conversation too long': 'Send /new to start a new conversation.',
  'Agent unavailable': 'Send /agent to pick another agent, then /new and your message again. A project admin can also fix the agent in Kortix.',
  'Model unavailable': 'Send /model to pick another model, then send your message again.',
  'ChatGPT login needs reconnection': 'Whoever connected the ChatGPT account must reconnect it in Kortix. Then send your message again.',
  'Provider rejected the request': 'A workspace admin can check the model provider settings in Kortix. Then send your message again.',
  'Provider unavailable': 'Send your message again to retry.',
  'Request blocked': 'Rephrase the request, then send it again.',
};
const RUN_ERROR_FALLBACK_ADVICE = 'Send your message again, or send /new to start a new conversation.';

/** The chat's settings row key (`chat_channel_bindings`): the chat, so a forum's topics share one. */
const telegramSettings = (target: ChannelTarget): SettingsChannel => ({
  platform: 'telegram',
  teamId: target.workspaceId,
  channelId: target.threadId.split(':')[0]!,
});

export const telegramPort: ChannelPort & { questions: QuestionPort } = {
  async notify(target, notice) {
    const text = telegramNotice(target, notice);
    if (!text) return;
    const token = await loadTelegramBotToken(target.projectId);
    if (token) await sendTelegramReply(token, target, text);
  },
  questions: telegramQuestions,
  turnModel: (target, thread) => chatTurnModel(telegramSettings(target), thread),
};

/**
 * Buttons answer through `callback_query` updates. A bot connected before
 * buttons gets messages only: subscribe it once, on its own URL with its own
 * secret, keeping the updates Telegram still holds. Only this project's webhook:
 * one bot can be installed in several projects, and re-pointing another
 * project's webhook with this project's secret would deafen it. False: post text.
 */
async function subscribeToButtons(token: string, projectId: string): Promise<boolean> {
  try {
    const info = await telegramCall<{ url?: string; allowed_updates?: string[] }>(token, 'getWebhookInfo');
    if (!info.url?.endsWith(`/v1/webhooks/telegram/${projectId}`)) return false;
    // Absent: Telegram's default set, which carries callback_query.
    if (!info.allowed_updates || info.allowed_updates.includes('callback_query')) return true;
    const secret = await loadTelegramWebhookSecret(projectId);
    if (!secret) return false;
    await telegramCall(token, 'setWebhook', { url: info.url, secret_token: secret, allowed_updates: TELEGRAM_UPDATES });
    logger.info('[telegram] bot subscribed to button presses', { projectId });
    return true;
  } catch (error) {
    logger.warn('[telegram] button subscription failed; the question is posted as text', { projectId, error: String(error) });
    return false;
  }
}

/** The chat's words for a notice; null says nothing. */
export function telegramNotice(target: ChannelTarget, notice: ChannelNotice): string | null {
  switch (notice.kind) {
    case 'create_pending':
      return 'Kortix is still starting a session for this chat. The agent replies here when it is ready.';
    case 'create_in_flight':
      return 'Kortix is still starting a session for this chat. Send your message again in a minute.';
    case 'create_failed':
      return startErrorMessage(notice.error.status, notice.error.body, TELEGRAM_START_ERROR_COMMANDS);
    case 'follow_up_failed':
      return "This chat's Kortix session cannot take new messages. Send /new to start a new conversation, then send your message again.";
    case 'run_failed': {
      const { title, aborted } = classifyTurnError(notice.error);
      // A stop is not a failure; the push skips it too (notifications/session-push.ts).
      if (aborted) return null;
      // The title comes from a closed set: the provider's own message never reaches the chat.
      return [
        `Kortix could not finish this run: ${title}.`,
        RUN_ERROR_ADVICE[title] ?? RUN_ERROR_FALLBACK_ADVICE,
        `Details: ${sessionWebUrl(config.FRONTEND_URL, target.projectId, notice.sessionId)}`,
      ].join('\n');
    }
    case 'start_retrying':
      return [
        `Kortix could not start this chat's session yet. ${notice.reason}`,
        'Kortix tries again automatically for a few minutes. If the agent does not reply, send /new, then send your message again.',
      ].join('\n');
    case 'start_failed':
      return [
        `Kortix could not start this chat's session, so the agent did not run.${notice.reason ? ` ${notice.reason}` : ''}`,
        'Send /new, then send your message again. If it fails again, a project admin can check the session in Kortix.',
        `Details: ${sessionWebUrl(config.FRONTEND_URL, target.projectId, notice.sessionId)}`,
      ].join('\n');
  }
}

export async function handleTelegramEvent(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  const message = event.data.message as unknown as TelegramMessage;
  const [project] = await db.select().from(projects).where(eq(projects.projectId, event.projectId)).limit(1);
  if (!project) return;
  const [install, token] = await Promise.all([
    loadTelegramInstall(event.projectId),
    loadTelegramBotToken(event.projectId),
  ]);
  if (!install || !token) return;

  const text = (message.text ?? message.caption ?? '').trim();
  const senderId = message.from?.id == null ? '' : String(message.from.id);
  const target: ChannelTarget = {
    platform: 'telegram',
    workspaceId: install.botId,
    threadId: telegramThreadId(message),
    projectId: event.projectId,
    messageId: String(message.message_id),
  };
  const reply = (body: string) => sendTelegramReply(token, target, body);

  const refusal = await gateSender(telegramAccessPort, {
    projectId: event.projectId,
    scopeId: install.botId,
    lists: install,
    senderId,
    direct: message.chat.type === 'private',
    from: message.from,
  });
  if (refusal) {
    await reply(refusal);
    return;
  }
  await repairTelegramMenu(token, install.botId);
  const createClaim = `telegram:threadcreate:${event.projectId}:${install.botId}:${target.threadId}`;
  const file = telegramFileOf(message);
  const command = parseChannelCommand(text, install.username);
  if (command) {
    await runChannelCommand(
      {
        target,
        project,
        settings: telegramSettings(target),
        label: { name: telegramChatName(message.chat), type: message.chat.type },
        createClaim,
        questions: telegramQuestions,
        ...(file ? { droppedFile: file.kind } : {}),
      },
      command,
      async (body) => {
        const m = telegramCommandMessage(body);
        if (m.keyboard.length) await ensureTelegramButtons(token, event.projectId, install.botId);
        await sendTelegramReply(token, target, clip(m.text, CHANNELS.telegram.messageChars), m.keyboard);
      },
    );
    return;
  }
  await clearQuestionButtons(telegramQuestions, target, 'answered_in_chat');

  await telegramCall(token, 'sendChatAction', {
    chat_id: message.chat.id,
    action: 'typing',
    ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
  }).catch(() => undefined);

  await routeChannelMessage(
    telegramPort,
    {
      target,
      keys: {
        followUp: `telegram:${install.botId}:${event.id}`,
        create: `telegram:create:${install.botId}:${event.id}`,
        createClaim,
      },
      followUp: { text: channelPromptText(telegramEnvelope(message)) },
      files: file
        ? [{
            kind: file.kind,
            ...(file.name ? { name: file.name } : {}),
            mime: file.mime,
            ...(file.ref.file_size ? { size: file.ref.file_size } : {}),
            read: (maxBytes) => telegramFile(token, file.ref.file_id, maxBytes),
          }]
        : [],
      plan: async (revived) => {
        const start = await chatSessionStart(telegramSettings(target), project).catch((error) => {
          logger.warn('[telegram] chat settings unreadable; the session starts on the defaults', { projectId: event.projectId, error: String(error) });
          return { agentName: 'default' } as Awaited<ReturnType<typeof chatSessionStart>>;
        });
        if (start.unavailableModel) {
          await reply(`Kortix did not send your message: this chat's model ${start.unavailableModel} is not available any more. Pick another with /model, then send your message again.`);
          return null;
        }
        return {
          project,
          visibility: 'project',
          body: {
            agent_name: start.agentName,
            ...(start.model ? { opencode_model: start.model } : {}),
            ...(start.pools ? { provider_secret_pools: start.pools } : {}),
            title_source: text || null,
          },
          metadata: {
            telegram: {
              bot_id: install.botId,
              chat_id: message.chat.id,
              chat_type: message.chat.type,
              from_id: message.from?.id,
              message_id: message.message_id,
            },
          },
          prompt: channelPromptText(telegramEnvelope(message), { revived }),
        };
      },
    },
    run,
  );
}

/**
 * A tap on an inline button. From an allowed user, a command button (`kc:`)
 * runs its command over the pressed message (`handleTelegramCommandPress`), and
 * a question button answers the question (core/questions.ts `handleQuestionTap`).
 * A tap from anyone else answers nothing.
 */
export async function handleTelegramPress(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  const press = event.data.callback_query as unknown as TelegramCallbackQuery;
  const [install, token] = await Promise.all([loadTelegramInstall(event.projectId), loadTelegramBotToken(event.projectId)]);
  if (!install || !token) return;

  // The same gate as a typed message. An alert, never a chat message: in a group
  // the pairing reply would reach everyone.
  if (!install.allowedUserIds.includes(String(press.from.id))) {
    await answerPress(token, press.id, refusedPressText(telegramAccessPort, String(press.from.id)), true);
    return;
  }
  const message = press.message;
  // No message to answer in (an inline-mode press, which Kortix never asks for).
  if (!message) return void (await answerPress(token, press.id));
  if (isCommandPressData(press.data ?? '')) return handleTelegramCommandPress(event, install.botId, token, press, message);
  const ref = String(message.message_id);
  await handleQuestionTap(
    telegramPort,
    {
      target: { platform: 'telegram', workspaceId: install.botId, threadId: telegramThreadId(message), projectId: event.projectId, messageId: ref },
      ref,
      data: press.data ?? '',
      id: press.id,
    },
    (threadId, answer) => {
      const [, topicId] = threadId.split(':');
      const reply: TelegramMessage = {
        message_id: message.message_id,
        chat: message.chat,
        from: press.from,
        text: answer,
        ...(topicId ? { is_topic_message: true, message_thread_id: Number(topicId) } : {}),
      };
      return {
        keys: {
          followUp: `telegram:${install.botId}:${event.id}`,
          create: `telegram:create:${install.botId}:${event.id}`,
          createClaim: `telegram:threadcreate:${event.projectId}:${install.botId}:${threadId}`,
        },
        followUp: { text: channelPromptText(telegramEnvelope(reply)) },
      };
    },
    run,
  );
}

/** A tap on a command button: the core runs it in the pressed message's chat and topic (core/commands.ts `runCommandPress`). */
async function handleTelegramCommandPress(
  event: IntegrationEvent,
  botId: string,
  token: string,
  press: TelegramCallbackQuery,
  message: NonNullable<TelegramCallbackQuery['message']>,
): Promise<void> {
  const [project] = await db.select().from(projects).where(eq(projects.projectId, event.projectId)).limit(1);
  if (!project) return void (await answerPress(token, press.id));
  const target: ChannelTarget = {
    platform: 'telegram',
    workspaceId: botId,
    threadId: telegramThreadId(message),
    projectId: event.projectId,
    messageId: String(message.message_id),
  };
  await runCommandPress(
    {
      target,
      project,
      settings: telegramSettings(target),
      // The stored press keeps no chat names (telegramPressEvent): a row this press creates has none.
      label: { name: null, type: message.chat.type },
      createClaim: `telegram:threadcreate:${event.projectId}:${botId}:${target.threadId}`,
      questions: telegramQuestions,
    },
    press.data!,
    (reply) => editTelegramCommand(token, message, reply),
    async (text) => void (await answerPress(token, press.id, text)),
  );
}

/** Draw a command reply over the pressed message. An unchanged page ("message is not modified") is not logged. */
async function editTelegramCommand(token: string, message: { message_id: number; chat: { id: number } }, reply: CommandReply): Promise<void> {
  const m = telegramCommandMessage(reply);
  await telegramCall(token, 'editMessageText', {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: clip(m.text, CHANNELS.telegram.messageChars),
    // Empty: the buttons go.
    reply_markup: { inline_keyboard: m.keyboard },
  }).catch((error) => {
    // ponytail: a refused edit (message deleted or too old) leaves the menu; send the reply as a new message if that matters.
    if (!String(error).includes('message is not modified')) logger.warn('[telegram] command reply not drawn', { error: String(error) });
  });
}

/** The session's thread in this chat (the chat itself, or one of its forum topics), on this bot. */
async function telegramThreadOfSession(sessionId: string, botId: string, chatId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: chatThreads.threadId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'telegram'),
        eq(chatThreads.workspaceId, botId),
        eq(chatThreads.sessionId, sessionId),
        or(eq(chatThreads.threadId, chatId), like(chatThreads.threadId, `${chatId}:%`)),
      ),
    )
    .limit(1);
  return row?.threadId ?? null;
}

type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

/**
 * A command's reply (core/commands.ts `CommandReply`) as plain chat text and an inline keyboard:
 * one row per option, then the page row, then the actions in pairs, then a panel's https link.
 * Any other link is the last text line: Telegram may refuse a URL button for a host such as localhost.
 */
function telegramCommandMessage(reply: CommandReply): { text: string; keyboard: InlineButton[][] } {
  const button = (label: string, press: CommandPress): InlineButton => ({ text: clip(label, 60), callback_data: pressData(press) });
  const lines: string[] = [];
  const keyboard: InlineButton[][] = [];
  switch (reply.kind) {
    case 'notice':
      lines.push(reply.text);
      break;
    case 'panel':
      lines.push(reply.title, ...reply.rows.map((r) => `${r.label}: ${r.value}`));
      break;
    case 'choices': {
      lines.push(`${reply.title}${reply.pages > 1 ? ` (page ${reply.page + 1} of ${reply.pages})` : ''}`, reply.usage);
      keyboard.push(...reply.options.map((o) => [button(`${o.current ? '✓ ' : ''}${o.label}`, o.press)]));
      const turn = [...(reply.back ? [button('‹ Back', reply.back)] : []), ...(reply.more ? [button('More ›', reply.more)] : [])];
      if (turn.length) keyboard.push(turn);
      break;
    }
    case 'help':
      lines.push(reply.intro, ...reply.commands.map((c) => `${c.usage} — ${c.description}`), reply.footer);
      break;
  }
  const actions = (reply.actions ?? []).map((a) => button(a.label, a.press));
  for (let i = 0; i < actions.length; i += 2) keyboard.push(actions.slice(i, i + 2));
  const url = 'url' in reply ? reply.url : undefined;
  if (url && reply.kind === 'panel' && url.startsWith('https://')) keyboard.push([{ text: 'Open in Kortix', url }]);
  else if (url) lines.push(url);
  return { text: reply.note ? `${lines.join('\n')}\n\n${reply.note}` : lines.join('\n'), keyboard };
}

/**
 * Once per bot: a bot connected before #10994 (2026-10-28) receives messages only
 * (`allowed_updates: ['message']`), so its buttons would never answer. Not
 * subscribed: the claim goes, and the next menu tries again.
 */
async function ensureTelegramButtons(token: string, projectId: string, botId: string): Promise<void> {
  const key = `telegram:buttons:${botId}`;
  const claim = await claimThreadCreate(key, 365 * 24 * 60 * 60_000).catch(() => null);
  if (claim && !(await subscribeToButtons(token, projectId))) await releaseThreadCreate(key, claim).catch(() => undefined);
}

/** What the Kortix Channels page calls a chat: its title, else the @username or the first name of a private chat. */
function telegramChatName(chat: TelegramMessage['chat']): string | null {
  return chat.title || (chat.username ? `@${chat.username}` : chat.first_name) || null;
}

/**
 * One reply path for commands and notices: the chat and topic come from the
 * target's thread id. A target found from a session has no message to answer,
 * so its notice is posted unanchored.
 */
async function sendTelegramReply(token: string, target: ChannelTarget, text: string, keyboard: InlineButton[][] = []): Promise<void> {
  const [chatId, topicId] = target.threadId.split(':');
  await telegramCall(token, 'sendMessage', {
    chat_id: Number(chatId),
    text,
    ...(target.messageId
      ? { reply_parameters: { message_id: Number(target.messageId), allow_sending_without_reply: true } }
      : {}),
    ...(topicId ? { message_thread_id: Number(topicId) } : {}),
    ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }).catch((error) => logger.warn('[telegram] reply failed', { error: String(error) }));
}

/**
 * One message for the agent and the session view (`channelPromptText`). A
 * button press keeps no names (`telegramPressEvent`), so its sender is the
 * username or the id.
 */
/** "/new, /stop, … and /help": the commands the agent never receives. */
const COMMAND_NAMES = CHANNEL_COMMANDS.map((c) => `/${c.name}`);
const KORTIX_COMMANDS = `${COMMAND_NAMES.slice(0, -1).join(', ')} and ${COMMAND_NAMES.at(-1)}`;

export function telegramEnvelope(message: TelegramMessage): ChannelEnvelope {
  const { chat, from } = message;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ');
  const topic = message.is_topic_message ? message.message_thread_id : undefined;
  return {
    platform: CHANNELS.telegram.envelope,
    sender: from?.username ? `@${from.username}` : name || `user ${from?.id ?? 'unknown'}`,
    where: chat.type === 'private' ? 'direct message' : chat.title || `chat ${chat.id}`,
    text: telegramText(message),
    reply: connectorReply(TELEGRAM_CHANNEL_CONNECTOR_SLUG, 'send_message', {
      chat_id: String(chat.id),
      text: '<reply>',
      reply_parameters: { message_id: message.message_id },
      ...(topic ? { message_thread_id: topic } : {}),
    }),
    notes: [
      `Chat ${chat.id} (${chat.type})${topic ? `, topic ${topic}` : ''}, sender id ${from?.id ?? 'unknown'}, message id ${message.message_id}.`,
      ...(message.media_group_id
        ? ['This message is one item of an album. Telegram sends each item as its own message, and usually only the first carries the caption.']
        : []),
      `One message holds at most ${CHANNELS.telegram.messageChars} characters; send a longer answer as several messages.`,
      'To let the user choose between options, call your question tool: Kortix posts it in this chat when it can, with buttons for a single choice; otherwise its result says how to ask.',
      `While you work on a long task, show typing: ${connectorReply(TELEGRAM_CHANNEL_CONNECTOR_SLUG, 'send_chat_action', { chat_id: String(chat.id) })}.`,
      'For bold or code, add `"parse_mode":"HTML"` and use <b>, <i>, <code>, <pre>; otherwise send plain text.',
      'The bot token is resolved server-side. Do not look for it in the sandbox.',
      `The next message in this chat continues this session. Kortix answers ${KORTIX_COMMANDS} in the chat itself; those commands never reach you.`,
    ],
  };
}

// One queue for every Telegram update: a replica on older code fails a press
// (it has no message), and the retry reaches a replica that knows it.
registerEventConsumer('telegram.', (event, run) =>
  event.type === TELEGRAM_PRESS_EVENT ? handleTelegramPress(event, run) : handleTelegramEvent(event, run));
registerSessionPort('telegram', telegramPort);
