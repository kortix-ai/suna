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
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { TELEGRAM_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { type ChannelMessage, type ChannelPort, forgetChatThread, routeChannelMessage } from '../core/conversation';
import type { ChatThreadKey } from '../core/threads';
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

interface TelegramChannelMessage extends ChannelMessage {
  message: TelegramMessage;
  /** The install's bot token, for the server's own replies. */
  token: string;
  text: string;
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

const telegramPort: ChannelPort<TelegramChannelMessage> = {
  source: 'telegram',
  prompt: (m, kind) => renderTelegramPrompt(m.message, kind === 'follow-up' ? 'follow-up' : 'new'),
  planCreate: async (m) => ({
    body: { agent_name: 'default', title_source: m.text || null },
    visibility: 'project',
    metadata: {
      telegram: {
        bot_id: m.thread.workspaceId,
        chat_id: m.message.chat.id,
        chat_type: m.message.chat.type,
        from_id: m.message.from?.id,
        message_id: m.message.message_id,
      },
    },
  }),
  notify: (m, notice) => {
    switch (notice.kind) {
      case 'follow_up_failed':
        return sendTelegramReply(m.token, m.message, 'This chat\'s Kortix session has failed and cannot take messages. Send /new to start a new conversation.');
      case 'create_pending':
        return sendTelegramReply(m.token, m.message, 'Kortix is still starting a session for this chat. The agent replies here when it is ready.');
      case 'create_in_flight':
        return sendTelegramReply(m.token, m.message, 'Kortix is still starting a session for this chat. Send your message again in a minute.');
      case 'create_failed':
        return sendTelegramReply(m.token, m.message, startErrorMessage(notice.error.status, notice.error.body, TELEGRAM_START_ERROR_COMMANDS));
    }
  },
};

export async function handleTelegramEvent(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  const message = event.data.message as unknown as TelegramMessage;
  const [install, token] = await Promise.all([
    loadTelegramInstall(event.projectId),
    loadTelegramBotToken(event.projectId),
  ]);
  if (!install || !token) return;

  const text = (message.text ?? message.caption ?? '').trim();
  const senderId = message.from?.id == null ? '' : String(message.from.id);
  const reply = (body: string) => sendTelegramReply(token, message, body);

  if (!senderId || !install.allowedUserIds.includes(senderId)) {
    await reply(
      `This bot belongs to a Kortix project, and your Telegram account is not allowed to use it yet. ` +
        `Ask a project admin to allow your Telegram user id ${senderId || '(unknown)'} under Channels → Telegram.`,
    );
    return;
  }
  const thread: ChatThreadKey = { platform: 'telegram', workspaceId: install.botId, threadId: telegramThreadId(message) };
  const claimKey = `telegram:threadcreate:${event.projectId}:${install.botId}:${thread.threadId}`;
  if (/^\/start(@\w+)?\b/.test(text)) {
    await reply('Connected to Kortix. Send a message to start working with the agent. /new starts a new conversation.');
    return;
  }
  if (/^\/new(@\w+)?\b/.test(text)) {
    await forgetChatThread(thread, claimKey);
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
      thread,
      projectId: event.projectId,
      keys: {
        followUp: `telegram:${install.botId}:${event.id}`,
        create: `telegram:create:${install.botId}:${event.id}`,
        claim: claimKey,
      },
      message,
      token,
      text,
    },
    run,
  );
}

async function sendTelegramReply(token: string, message: TelegramMessage, text: string): Promise<void> {
  await telegramCall(token, 'sendMessage', {
    chat_id: message.chat.id,
    text,
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
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
