/**
 * Telegram as a channel connector. The webhook stores each
 * update in the integration event inbox; this consumer turns a stored message
 * into a session turn through the conversation core (channels/core/conversation.ts):
 *
 *   unknown sender  → a pairing reply naming their user id, no session (fail closed);
 *                     in a private chat, also an access request an admin can allow
 *   `/start`        → a welcome reply
 *   `/new`          → forget the chat's session; the next message starts a new one
 *   anything else   → the core: a follow-up into the chat's session, or a new
 *                     project-visible session bound to the chat
 *   a button press  → the answer to the agent's question (`handleTelegramPress`,
 *                     through core/questions.ts)
 *
 * The agent answers through the `kortix_telegram` connector (connectors/channels.ts);
 * the bot token never enters the sandbox.
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { chatThreads, projects } from '@kortix/db';
import { and, eq, like, or } from 'drizzle-orm';
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { db } from '../../shared/db';
import { databaseErrorSummary } from '../../shared/database-errors';
import { TELEGRAM_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { type ChannelNotice, type ChannelPort, type ChannelTarget, forgetChatThread, routeChannelMessage } from '../core/conversation';
import {
  clearQuestionButtons,
  handleQuestionTap,
  type QuestionFooter,
  type QuestionMessage,
  type QuestionPort,
} from '../core/questions';
import { registerSessionPort } from '../core/session-notice';
import { classifyTurnError } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { startErrorMessage, TELEGRAM_START_ERROR_COMMANDS } from '../start-error';
import { TELEGRAM_UPDATES, telegramCall } from './api';
import { loadTelegramBotToken, loadTelegramInstall, loadTelegramWebhookSecret, recordTelegramAccessRequest } from './installs';

export const TELEGRAM_MESSAGE_EVENT = 'telegram.message.created';

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string; title?: string };
  from?: { id?: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
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

/** The inbox envelope for an update, or null when it carries nothing to answer. Edits are skipped. */
export function telegramMessageEvent(
  projectId: string,
  botId: string,
  update: TelegramUpdate,
): IntegrationEvent | null {
  const message = update.message;
  if (!message?.chat || message.from?.is_bot) return null;
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
const MAX_BUTTONS = 6;
/** A message holds 4096 characters (connectors/channels.ts); the footer gets 190 of them. */
const QUESTION_BODY_MAX = 3900;
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
  'Agent unavailable': 'A project admin can fix the agent in Kortix. Then send /new and your message again.',
  'Model unavailable': 'A project admin can pick another model in Kortix. Then send /new and your message again.',
  'ChatGPT login needs reconnection': 'Whoever connected the ChatGPT account must reconnect it in Kortix. Then send your message again.',
  'Provider rejected the request': 'A workspace admin can check the model provider settings in Kortix. Then send your message again.',
  'Provider unavailable': 'Send your message again to retry.',
  'Request blocked': 'Rephrase the request, then send it again.',
};
const RUN_ERROR_FALLBACK_ADVICE = 'Send your message again, or send /new to start a new conversation.';

export const telegramPort: ChannelPort & { questions: QuestionPort } = {
  async notify(target, notice) {
    const text = telegramNotice(target, notice);
    if (!text) return;
    const token = await loadTelegramBotToken(target.projectId);
    if (token) await sendTelegramReply(token, target, text);
  },
  questions: telegramQuestions,
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

  if (!senderId || !install.allowedUserIds.includes(senderId)) {
    // Only a private chat asks for access: there the sender wrote to the bot itself.
    const asks = !!senderId && message.chat.type === 'private';
    const waiting =
      asks &&
      (await recordTelegramAccessRequest(event.projectId, install, message.from!).catch((error) => {
        // A failed query's message carries its parameters, the sender's names among them.
        logger.warn('[telegram] access request not recorded', {
          projectId: event.projectId,
          error: databaseErrorSummary(error) ?? String(error),
        });
        return false;
      }));
    await reply(
      `This bot belongs to a Kortix project, and your Telegram account is not allowed to use it yet. ` +
        (waiting
          ? `Your request is waiting for a project admin, who can allow it in Kortix under Customize → Connectors → Channels → Telegram. Your Telegram user ID is ${senderId}.`
          : `Ask a project admin to allow your Telegram user ID ${senderId || '(unknown)'} under Customize → Connectors → Channels → Telegram${asks ? '' : ', or message this bot privately to ask for access'}.`),
    );
    return;
  }
  const createClaim = `telegram:threadcreate:${event.projectId}:${install.botId}:${target.threadId}`;
  const startingOver = /^\/new(@\w+)?\b/.test(text);
  if (!/^\/start(@\w+)?\b/.test(text)) {
    await clearQuestionButtons(telegramQuestions, target, startingOver ? 'new_conversation' : 'answered_in_chat');
  }
  if (/^\/start(@\w+)?\b/.test(text)) {
    await reply('Connected to Kortix. Send a message to start working with the agent. /new starts a new conversation.');
    return;
  }
  if (startingOver) {
    await forgetChatThread(target, createClaim);
    await reply('Started a new conversation. Your next message goes to a new session.');
    return;
  }

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
      followUp: { text: renderTelegramPrompt(message, 'follow-up') },
      // A revived chat starts with the `new` prompt: the agent reads the chat afresh.
      plan: async () => ({
        project,
        visibility: 'project',
        body: { agent_name: 'default', title_source: text || null },
        metadata: {
          telegram: {
            bot_id: install.botId,
            chat_id: message.chat.id,
            chat_type: message.chat.type,
            from_id: message.from?.id,
            message_id: message.message_id,
          },
        },
        prompt: renderTelegramPrompt(message, 'new'),
      }),
    },
    run,
  );
}

/**
 * A tap on a question button. From an allowed user, the core answers the
 * question with it (core/questions.ts `handleQuestionTap`). A tap from anyone
 * else answers nothing.
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
    await answerPress(token, press.id, `Your Telegram account is not allowed to use this bot. Ask a project admin to allow user ID ${press.from.id} under Customize → Connectors → Channels → Telegram.`, true);
    return;
  }
  const message = press.message;
  // No message to answer in (an inline-mode press, which Kortix never asks for).
  if (!message) return void (await answerPress(token, press.id));
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
        followUp: { text: renderTelegramPrompt(reply, 'follow-up') },
      };
    },
    run,
  );
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

/**
 * One reply path for commands and notices: the chat and topic come from the
 * target's thread id. A target found from a session has no message to answer,
 * so its notice is posted unanchored.
 */
async function sendTelegramReply(token: string, target: ChannelTarget, text: string): Promise<void> {
  const [chatId, topicId] = target.threadId.split(':');
  await telegramCall(token, 'sendMessage', {
    chat_id: Number(chatId),
    text,
    ...(target.messageId
      ? { reply_parameters: { message_id: Number(target.messageId), allow_sending_without_reply: true } }
      : {}),
    ...(topicId ? { message_thread_id: Number(topicId) } : {}),
  }).catch((error) => logger.warn('[telegram] reply failed', { error: String(error) }));
}

/** The turn prompt: the message, then how to answer through the connector CLI (works on every harness). */
export function renderTelegramPrompt(message: TelegramMessage, kind: 'new' | 'follow-up'): string {
  const from = message.from?.username ? `@${message.from.username}` : String(message.from?.id ?? 'unknown');
  const replyArgs = JSON.stringify({
    chat_id: String(message.chat.id),
    text: '<reply>',
    reply_parameters: { message_id: message.message_id },
    ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
  });
  return [
    kind === 'new' ? 'You received a message on Telegram.' : `New Telegram message from ${from} in the same chat:`,
    '',
    `Chat:       ${message.chat.id} (${message.chat.type})`,
    `From:       ${from}`,
    `Message id: ${message.message_id}`,
    '',
    message.text ?? message.caption ?? '(no text: a photo, file or sticker)',
    '',
    'How to answer:',
    `- Reply with the ${TELEGRAM_CHANNEL_CONNECTOR_SLUG} connector through the shell: \`kortix connectors call ${TELEGRAM_CHANNEL_CONNECTOR_SLUG}.send_message '${replyArgs}'\`.`,
    '- One message holds at most 4096 characters; send a longer answer as several messages.',
    '- To let the user choose between options, call your question tool: Kortix posts it in this chat when it can, with buttons for a single choice; otherwise its result says how to ask.',
    `- While you work on a long task, show typing: \`kortix connectors call ${TELEGRAM_CHANNEL_CONNECTOR_SLUG}.send_chat_action '{"chat_id":"${message.chat.id}"}'\`.`,
    '- For bold or code, add `"parse_mode":"HTML"` and use <b>, <i>, <code>, <pre>; otherwise send plain text.',
    '- The bot token is resolved server-side. Do not look for it in the sandbox.',
    '- The next message in this chat continues this session; /new in Telegram starts a fresh one.',
  ].join('\n');
}

// One queue for every Telegram update: a replica on older code fails a press
// (it has no message), and the retry reaches a replica that knows it.
registerEventConsumer('telegram.', (event, run) =>
  event.type === TELEGRAM_PRESS_EVENT ? handleTelegramPress(event, run) : handleTelegramEvent(event, run));
registerSessionPort('telegram', telegramPort);
