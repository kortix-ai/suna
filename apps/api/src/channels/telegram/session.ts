/**
 * Telegram as a channel connector (connectors_v2). The webhook stores each
 * update in the integration event inbox; this consumer turns a stored message
 * into a session turn:
 *
 *   unknown sender  → a pairing reply naming their user id, no session (fail closed)
 *   `/start`        → a welcome reply
 *   `/new`          → forget the chat's session; the next message starts a new one
 *   a known chat    → a follow-up into its session
 *   a new chat      → a new project-visible session bound to the chat
 *
 * The agent answers through the `kortix_telegram` connector (connectors/channels.ts);
 * the bot token never enters the sandbox.
 */
import { chatEventDedup, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import {
  createSession as createLifecycleSession,
  deliverThroughQueue,
  resolveProjectAutomationActor,
} from '../../projects/surface';
import { db } from '../../shared/db';
import { TELEGRAM_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { type ChatThreadKey, dropChatThread, findChatThread, touchChatThread } from '../core/threads';
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

const defaultLifecycle = { createSession: createLifecycleSession, deliverThroughQueue, resolveProjectAutomationActor };
let lifecycle = defaultLifecycle;

export function setTelegramLifecycleForTest(overrides: Partial<typeof defaultLifecycle>): void {
  lifecycle = { ...defaultLifecycle, ...overrides };
}

export function resetTelegramLifecycleForTest(): void {
  lifecycle = defaultLifecycle;
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

export async function handleTelegramEvent(event: IntegrationEvent): Promise<void> {
  const message = event.data.message as unknown as TelegramMessage;
  const [project] = await db.select().from(projects).where(eq(projects.projectId, event.projectId)).limit(1);
  if (!project || !resolveFeatureFlag(project.metadata, 'connectors_v2')) return;
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
  if (/^\/start(@\w+)?\b/.test(text)) {
    await reply('Connected to Kortix. Send a message to start working with the agent. /new starts a new conversation.');
    return;
  }
  if (/^\/new(@\w+)?\b/.test(text)) {
    await dropChatThread(thread);
    await reply('Started a new conversation. Your next message goes to a new session.');
    return;
  }

  await telegramCall(token, 'sendChatAction', {
    chat_id: message.chat.id,
    action: 'typing',
    ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
  }).catch(() => undefined);

  const existing = await findChatThread(thread);
  if (existing) {
    const outcome = await lifecycle.deliverThroughQueue({
      source: 'telegram',
      idempotencyKey: `telegram:${install.botId}:${event.id}`,
      projectId: event.projectId,
      sessionId: existing.sessionId,
      text: renderTelegramPrompt(message, 'follow-up'),
    });
    if (outcome === 'delivered' || outcome === 'queued') return touchChatThread(thread);
    if (outcome !== 'no-session') throw new Error(`telegram follow-up ${outcome}`);
    await dropChatThread(thread);
  }

  // Two messages racing into a new chat: one creates, the other follows up.
  const claimKey = `telegram:threadcreate:${install.botId}:${thread.threadId}`;
  if (!(await claimThreadCreate(claimKey))) {
    const sessionId = await waitForThreadSession(thread);
    if (!sessionId) throw new Error('telegram thread create in flight');
    await lifecycle.deliverThroughQueue({
      source: 'telegram',
      idempotencyKey: `telegram:${install.botId}:${event.id}`,
      projectId: event.projectId,
      sessionId,
      text: renderTelegramPrompt(message, 'follow-up'),
    });
    return;
  }

  const userId = await lifecycle.resolveProjectAutomationActor(project.accountId);
  if (!userId) throw new Error('no automation actor for the project');
  const result = await lifecycle.createSession({
    source: 'telegram',
    project,
    userId,
    requestingPrincipalType: 'human',
    body: { base_ref: project.defaultBranch, agent_name: 'default', title_source: text || null },
    queuePolicy: 'on_backpressure',
    idempotencyKey: `telegram:create:${install.botId}:${event.id}`,
    postCreate: [
      { type: 'bind_chat_thread', platform: 'telegram', workspaceId: install.botId, threadId: thread.threadId },
      { type: 'deliver_prompt', source: 'telegram', text: renderTelegramPrompt(message, 'new'), userId },
    ],
    visibility: 'project',
    metadata: {
      source: 'telegram',
      telegram: {
        bot_id: install.botId,
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        from_id: message.from?.id,
        message_id: message.message_id,
      },
    },
  });
  if (!result.error) return;
  // A create that went back to the lifecycle queue belongs to its drain: the
  // drain binds the thread and delivers the prompt when the session starts.
  // The claim stays, so a second message in this chat waits for that thread.
  if (result.requeued) {
    await reply('Kortix is still starting a session for this chat. The agent replies here when it is ready.');
    return;
  }
  // Any other failure is final for this message: say why, and free the chat
  // so a corrected re-send starts at once (the Slack and Teams behavior).
  logger.warn('[telegram] createSession failed', { status: result.error.status, projectId: event.projectId });
  await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claimKey));
  await reply(startErrorMessage(result.error.status, result.error.body, TELEGRAM_START_ERROR_COMMANDS));
}

async function sendTelegramReply(token: string, message: TelegramMessage, text: string): Promise<void> {
  await telegramCall(token, 'sendMessage', {
    chat_id: message.chat.id,
    text,
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
  }).catch((error) => logger.warn('[telegram] reply failed', { error: String(error) }));
}

async function claimThreadCreate(key: string): Promise<boolean> {
  const inserted = await db
    .insert(chatEventDedup)
    .values({ eventId: key, expiresAt: new Date(Date.now() + 10 * 60_000) })
    .onConflictDoNothing({ target: chatEventDedup.eventId })
    .returning({ eventId: chatEventDedup.eventId });
  return inserted.length > 0;
}

async function waitForThreadSession(thread: ChatThreadKey): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const row = await findChatThread(thread);
    if (row) return row.sessionId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
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
