/**
 * Telegram bot webhook — inbound updates for a project's BYO bot.
 *
 * Flow per update: verify `x-telegram-bot-api-secret-token` (constant-time,
 * 404 unconfigured / 401 mismatch) → dedupe update_id (Telegram RETRIES
 * webhook deliveries) → group etiquette gate (respond in groups only when
 * @-mentioned / replied-to) → bot commands (/start /help /new) → route into a
 * session: an existing chat_threads mapping continues the conversation as a
 * follow-up; a first message atomically claims the chat (single-winner
 * chat_event_dedup INSERT, same shadow-session guard as Slack) and creates a
 * session honoring the channel binding's agent/model/policy overrides.
 *
 * The bot token never appears here beyond server-side sendMessage acks — and
 * never in anything a sandbox sees (buildTelegramTurnEnv is context-only).
 */

import { createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatEventDedup, chatThreads, projects } from '@kortix/db';
import { db } from '../shared/db';
import {
  continueSession,
  createSession,
  resolveProjectAutomationActor,
} from '../projects/session-lifecycle';
import {
  loadTelegramInstall,
  loadTelegramTokenForProject,
  loadTelegramWebhookSecretForProject,
} from './install-store';
import { telegramSendMessage } from './telegram-api';
import { currentChannelSelection } from './slack/selection';
import { normalizeConversationPolicy } from './slack/participants';
import { EVENT_DEDUPE_TTL_MS } from './slack/app';
import {
  parseTelegramCommand,
  renderTelegramAgentPrompt,
  renderTelegramFollowUpPrompt,
  shouldRespondInChat,
  TELEGRAM_HELP_TEXT,
  TELEGRAM_NEW_TEXT,
  TELEGRAM_START_TEXT,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram/inbound';
import {
  finalizeTelegramTurnDirect,
  restartTelegramTurnForFollowUp,
  saveTelegramTurn,
  startTelegramTurn,
  telegramQueuedMessage,
  telegramStartErrorMessage,
} from './telegram/turn';
import { makeOpenApiApp, json, errors } from '../openapi';

export const telegramWebhookApp = makeOpenApiApp();

telegramWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}',
    tags: ['channels'],
    summary: 'Telegram bot webhook (secret-token verified)',
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), challenge: z.string().optional() }).passthrough(), 'Accepted'),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const expected = await loadTelegramWebhookSecretForProject(projectId);
    if (!expected) return c.json({ error: 'Not configured' }, 404);

    const presented = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    // Constant-time compare (matches Slack/GitHub webhook verification) so the
    // secret can't be recovered via response-timing differences.
    const presentedBuf = Buffer.from(presented);
    const expectedBuf = Buffer.from(expected);
    if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
      return c.json({ error: 'Invalid secret' }, 401);
    }

    let update: TelegramUpdate;
    try {
      update = (await c.req.json()) as TelegramUpdate;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const message = update.message ?? update.edited_message;
    if (!message || !message.chat) return c.json({ ok: true });

    // Telegram redelivers updates until it sees a 2xx — a slow session create
    // on the first delivery must not double-handle the retry. Cross-replica
    // safe (shared table); fail-open so a DB hiccup can't drop a message.
    if (!(await claimOnce(`telegram:update:${projectId}:${update.update_id}`))) {
      return c.json({ ok: true });
    }

    handleUpdate(projectId, update, message).catch((err) =>
      console.error('[telegram-webhook] handle failed', err),
    );
    return c.json({ ok: true });
  },
);

async function handleUpdate(
  projectId: string,
  update: TelegramUpdate,
  message: TelegramMessage,
): Promise<void> {
  const install = await loadTelegramInstall(projectId);
  if (!install) return; // disconnected between verify and handle
  const { botId, botUsername } = install;

  // Group etiquette: never answer un-addressed group chatter.
  if (!shouldRespondInChat(message, botUsername, botId)) return;

  const chatId = String(message.chat.id);
  const text = message.text ?? message.caption ?? '';

  // Bot commands answer immediately, server-side — no session involved.
  const command = parseTelegramCommand(text, botUsername);
  if (command) {
    const token = await loadTelegramTokenForProject(projectId);
    if (!token) return;
    if (command.command === 'new') {
      // Forget the chat's session mapping AND its create-claim so the next
      // message starts a genuinely fresh session (a lingering claim row would
      // strand the next create behind an 8s wait for a mapping that never
      // comes).
      await db
        .delete(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'telegram'),
            eq(chatThreads.workspaceId, botId),
            eq(chatThreads.threadId, chatId),
          ),
        );
      await db
        .delete(chatEventDedup)
        .where(eq(chatEventDedup.eventId, threadClaimKey(botId, chatId)));
      await telegramSendMessage(token, message.chat.id, TELEGRAM_NEW_TEXT, {
        replyToMessageId: message.message_id,
      });
      return;
    }
    const reply = command.command === 'start' ? TELEGRAM_START_TEXT : TELEGRAM_HELP_TEXT;
    await telegramSendMessage(token, message.chat.id, reply, {
      replyToMessageId: message.message_id,
    });
    return;
  }

  await createOrJoinChatSession({ projectId, botId, botUsername, chatId, message });
}

// Atomically create the durable session for a chat — or, if this chat already
// has one (or a concurrent first message is creating it), deliver this message
// into that session as a follow-up. Same single-winner claim discipline as
// Slack's createOrJoinThreadSession: claim BEFORE creating, losers wait for
// the winner's chat_threads mapping.
async function createOrJoinChatSession(input: {
  projectId: string;
  botId: string;
  botUsername: string | null;
  chatId: string;
  message: TelegramMessage;
}): Promise<void> {
  const { projectId, botId, botUsername, chatId, message } = input;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  // Sessions run as the project's automation actor (per-user Telegram identity
  // binding is out of scope for v1 — see docs/TELEGRAM_CHANNEL_PLAN.md).
  const userId = await resolveProjectAutomationActor(project.accountId);
  if (!userId) {
    console.warn('[telegram-webhook] no actor for project', projectId);
    return;
  }

  // Follow-ups get their own fresh placeholder (live-edited into the reply),
  // then continue the existing session.
  const followUp = async (sessionId: string) => {
    await restartTelegramTurnForFollowUp(sessionId, projectId, botId, message);
    await continueSession({
      source: 'telegram',
      sessionId,
      text: renderTelegramFollowUpPrompt(message, botUsername),
      userId,
    });
  };

  // Existing conversation → follow up into it.
  const existing = await chatSessionId(botId, chatId);
  if (existing) {
    await followUp(existing);
    return;
  }

  // First message: claim the create. Loser → wait for the winner's mapping.
  const claimKey = threadClaimKey(botId, chatId);
  if (!(await claimOnce(claimKey))) {
    const sessionId = await waitForChatSession(botId, chatId);
    if (sessionId) {
      await followUp(sessionId);
    } else {
      console.warn('[telegram-webhook] lost chat-create claim but winner never published a session', {
        botId,
        chatId,
      });
    }
    return;
  }

  // We won the claim — but a winner of a prior, now-expired claim may already
  // own this chat. Never create a second session; follow up instead.
  const raced = await chatSessionId(botId, chatId);
  if (raced) {
    await followUp(raced);
    return;
  }

  // Instant feedback while the sandbox spins up: typing cue + the placeholder
  // message the turn relay will live-edit into steps and finally the answer.
  const turnHandle = await startTelegramTurn(projectId, botId, message);

  // Surface the chat in the dashboard's Channels → Bindings list on first
  // contact, so its agent/model/policy can be tuned like a Slack channel.
  await ensureChannelBinding(projectId, botId, message);

  // Per-chat agent + model + conversation-policy overrides from the binding.
  const selection = await currentChannelSelection({
    platform: 'telegram',
    teamId: botId,
    channelId: chatId,
  });
  const conversationPolicy = normalizeConversationPolicy(selection?.conversationPolicy);

  const result = await createSession({
    source: 'telegram',
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: selection?.agentName ?? 'default',
      ...(selection?.opencodeModel ? { opencode_model: selection.opencodeModel } : {}),
      initial_prompt: renderTelegramAgentPrompt(message, botUsername),
    },
    enforceAccountCap: false,
    queuePolicy: 'on_backpressure',
    idempotencyKey: claimKey,
    postCreate: [
      { type: 'bind_chat_thread', platform: 'telegram', workspaceId: botId, threadId: chatId },
    ],
    // Channel sessions are team-facing by default; a binding's policy can
    // restrict them (same semantics as Slack).
    visibility: conversationPolicy === 'project_open' ? 'project' : 'restricted',
    metadata: {
      source: 'telegram',
      telegram: {
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        from_id: message.from?.id,
        message_id: message.message_id,
        conversation_policy: conversationPolicy,
      },
    },
    // Context-only env for the sandbox — NO token; the executor gateway
    // resolves credentials server-side (stage 3).
    extraEnvVars: buildTelegramTurnEnv(message),
  });

  if (result.error) {
    console.error('[telegram-webhook] createProjectSession failed', result.error.body);
    if (turnHandle) {
      await finalizeTelegramTurnDirect(
        turnHandle,
        telegramStartErrorMessage(result.error.status, result.error.body?.error),
      );
    }
    return;
  }

  if (result.status === 'queued' || result.status === 'pending') {
    if (turnHandle) {
      await finalizeTelegramTurnDirect(turnHandle, telegramQueuedMessage(result.reason));
    }
    return;
  }

  // Session is live — persist the turn under its id so the /turn-stream
  // relays (steps, answer, end) can find and live-edit the placeholder.
  if (result.sessionId && turnHandle) {
    turnHandle.sessionId = result.sessionId;
    await saveTelegramTurn(turnHandle);
  }
}

/** Sandbox env for telegram-originated turns: chat context ONLY, never a
 *  credential — the token stays server-side (executor gateway). */
export function buildTelegramTurnEnv(message: TelegramMessage): Record<string, string> {
  return {
    TELEGRAM_CHAT_ID: String(message.chat.id),
    TELEGRAM_CHAT_TYPE: message.chat.type,
    TELEGRAM_MESSAGE_ID: String(message.message_id),
    ...(message.from?.id != null ? { TELEGRAM_USER_ID: String(message.from.id) } : {}),
  };
}

function threadClaimKey(botId: string, chatId: string): string {
  return `telegram:threadcreate:${botId}:${chatId}`;
}

async function chatSessionId(botId: string, chatId: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'telegram'),
        eq(chatThreads.workspaceId, botId),
        eq(chatThreads.threadId, chatId),
      ),
    )
    .limit(1);
  return row?.sessionId ?? null;
}

// Single-winner INSERT … ON CONFLICT claim on the shared dedup table. True iff
// WE claimed it. Fail-open: better a rare duplicate than a dropped message.
async function claimOnce(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: key, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[telegram-webhook] dedup claim failed (fail-open)', err);
    return true;
  }
}

// Wait briefly for the claim winner to publish its chat_threads mapping so a
// losing concurrent message joins the same session instead of being dropped.
async function waitForChatSession(botId: string, chatId: string): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const found = await chatSessionId(botId, chatId);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// First-contact binding row: makes the chat visible/tunable in the dashboard's
// Channels → Bindings section (agent/model/policy). Never overwrites an
// existing binding — operators own those rows once created.
async function ensureChannelBinding(
  projectId: string,
  botId: string,
  message: TelegramMessage,
): Promise<void> {
  try {
    const [existing] = await db
      .select({ bindingId: chatChannelBindings.bindingId })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'telegram'),
          eq(chatChannelBindings.workspaceId, botId),
          eq(chatChannelBindings.channelId, String(message.chat.id)),
        ),
      )
      .limit(1);
    if (existing) return;
    await db
      .insert(chatChannelBindings)
      .values({
        projectId,
        platform: 'telegram',
        workspaceId: botId,
        channelId: String(message.chat.id),
        channelName:
          message.chat.title ??
          (message.chat.username ? `@${message.chat.username}` : null) ??
          (message.chat.type === 'private' ? senderName(message) : null),
        channelType: message.chat.type,
      })
      .onConflictDoNothing();
  } catch (err) {
    // Binding registration is a dashboard nicety — never fail the message on it.
    console.warn('[telegram-webhook] binding registration failed', err);
  }
}

function senderName(message: TelegramMessage): string | null {
  const from = message.from;
  if (from?.username) return `@${from.username}`;
  if (from?.first_name) return from.first_name;
  return null;
}
