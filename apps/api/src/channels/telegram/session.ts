/**
 * Telegram as a channel connector. The webhook stores each
 * update in the integration event inbox; this consumer turns a stored message
 * into a session turn through the conversation core (channels/core/conversation.ts):
 *
 *   unknown sender  → a pairing reply naming their user id, no session (fail closed)
 *   `/start`        → a welcome reply
 *   `/new`          → forget the chat's session; the next message starts a new one
 *   anything else   → the core: a follow-up into the chat's session, or a new
 *                     project-visible session bound to the chat
 *
 * The agent answers through the `kortix_telegram` connector (connectors/channels.ts);
 * the bot token never enters the sandbox.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { db } from '../../shared/db';
import { TELEGRAM_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { type ChannelNotice, type ChannelPort, type ChannelTarget, forgetChatThread, routeChannelMessage } from '../core/conversation';
import { classifyTurnError } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { startErrorMessage, TELEGRAM_START_ERROR_COMMANDS } from '../start-error';
import { telegramCall } from './api';
import { loadTelegramBotToken, loadTelegramInstall } from './installs';

export const TELEGRAM_MESSAGE_EVENT = 'telegram.message.created';

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string; title?: string };
  from?: { id?: number; username?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
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

export const telegramPort: ChannelPort = {
  async notify(target, notice) {
    const text = telegramNotice(target, notice);
    if (!text) return;
    const token = await loadTelegramBotToken(target.projectId);
    if (token) await sendTelegramReply(token, target, text);
  },
};

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
    await reply(
      `This bot belongs to a Kortix project, and your Telegram account is not allowed to use it yet. ` +
        `Ask a project admin to allow your Telegram user id ${senderId || '(unknown)'} under Channels → Telegram.`,
    );
    return;
  }
  const createClaim = `telegram:threadcreate:${event.projectId}:${install.botId}:${target.threadId}`;
  if (/^\/start(@\w+)?\b/.test(text)) {
    await reply('Connected to Kortix. Send a message to start working with the agent. /new starts a new conversation.');
    return;
  }
  if (/^\/new(@\w+)?\b/.test(text)) {
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
    `- While you work on a long task, show typing: \`kortix connectors call ${TELEGRAM_CHANNEL_CONNECTOR_SLUG}.send_chat_action '{"chat_id":"${message.chat.id}"}'\`.`,
    '- For bold or code, add `"parse_mode":"HTML"` and use <b>, <i>, <code>, <pre>; otherwise send plain text.',
    '- The bot token is resolved server-side. Do not look for it in the sandbox.',
    '- The next message in this chat continues this session; /new in Telegram starts a fresh one.',
  ].join('\n');
}

registerEventConsumer('telegram.', handleTelegramEvent);
