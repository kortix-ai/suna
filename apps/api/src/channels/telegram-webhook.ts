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

import { timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import {
  chatChannelBindings,
  chatEventDedup,
  chatThreads,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { errors, json, makeOpenApiApp } from '../openapi';
import {
  continueSession,
  createSession,
  resolveProjectAutomationActor,
} from '../projects/session-lifecycle';
import { db } from '../shared/db';
import {
  clearTelegramPairing,
  loadTelegramInstall,
  loadTelegramPairing,
  loadTelegramTokenForProject,
  loadTelegramWebhookSecretForProject,
} from './install-store';
import { EVENT_DEDUPE_TTL_MS } from './slack/app';
import { normalizeConversationPolicy } from './slack/participants';
import { currentChannelSelection } from './slack/selection';
import {
  telegramAnswerCallbackQuery,
  telegramEditMessageReplyMarkup,
  telegramEditMessageText,
  telegramSendMessage,
} from './telegram-api';
import {
  applyControlPick,
  isControlCallback,
  postTelegramAgentPicker,
  postTelegramModelPicker,
} from './telegram/controls';
import {
  TELEGRAM_GROUP_WELCOME_TEXT,
  TELEGRAM_HELP_TEXT,
  TELEGRAM_LOCKED_TEXT,
  TELEGRAM_NEW_TEXT,
  TELEGRAM_PAIRED_TEXT,
  TELEGRAM_PAIRING_FAILED_TEXT,
  TELEGRAM_START_TEXT,
  type TelegramCallbackQuery,
  type TelegramChatMemberUpdate,
  type TelegramMessage,
  type TelegramUpdate,
  botJustAddedToGroup,
  parseTelegramCommand,
  renderTelegramAgentPrompt,
  renderTelegramFollowUpPrompt,
  renderTelegramStatus,
  shouldRespondInChat,
} from './telegram/inbound';
import {
  addTelegramAllowedUser,
  telegramAllowedUserIds,
  telegramPairingMatches,
} from './telegram/pairing';
import {
  answerLabelFromKeyboard,
  isQuestionCallback,
  isSubmitCallback,
  isToggleCallback,
  selectedLabelsFromKeyboard,
  toggleKeyboardOption,
} from './telegram/questions';
import { applyTelegramReviewVerdict, isReviewCallback } from './telegram/review';
import {
  finalizeTelegramTurnDirect,
  restartTelegramTurnForFollowUp,
  saveTelegramTurn,
  startTelegramTurn,
  telegramQueuedMessage,
  telegramStartErrorMessage,
} from './telegram/turn';

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
      200: json(
        z.object({ ok: z.boolean(), challenge: z.string().optional() }).passthrough(),
        'Accepted',
      ),
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

    // Inline-keyboard taps (answers to a question) arrive as callback_query,
    // not message. Dedupe on the update id (Telegram redelivers on non-2xx).
    if (update.callback_query) {
      if (await claimOnce(`telegram:update:${projectId}:${update.update_id}`)) {
        handleCallbackQuery(projectId, update.callback_query).catch((err) =>
          console.error('[telegram-webhook] callback handle failed', err),
        );
      }
      return c.json({ ok: true });
    }

    // Bot membership changes (added to / removed from a group). Welcome on add.
    if (update.my_chat_member) {
      if (await claimOnce(`telegram:update:${projectId}:${update.update_id}`)) {
        handleMyChatMember(projectId, update.my_chat_member).catch((err) =>
          console.error('[telegram-webhook] my_chat_member handle failed', err),
        );
      }
      return c.json({ ok: true });
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

// Gate for the Telegram equivalent of Slack's SLACK_REQUIRE_USER_IDENTITY: the
// webhook otherwise runs every agent turn AS THE ACCOUNT OWNER for whoever can
// message the bot, with no sender check. Defaults ON: a webhook secret proves
// the request came from Telegram, but not that this sender may run this project
// as the automation actor. Operators may temporarily set
// TELEGRAM_REQUIRE_USER_IDENTITY=false only while migrating legacy projects to
// metadata.telegram.allowedUserIds.
// Read live (not module-scope) so it's cheap to flip per-request in tests.
export function telegramRequireUserIdentityForTest(): boolean {
  const raw = (process.env.TELEGRAM_REQUIRE_USER_IDENTITY ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

// "Bound identity" here is a per-project allowlist of Telegram user ids, stored
// in the existing projects.metadata jsonb column (no schema change) at
// metadata.telegram.allowedUserIds. There is no product surface to populate
// this yet — see risk note in the PR. Until one exists, enabling the flag
// rejects every sender for a project with no allowlist configured, which is
// the safe direction to fail in.
export function isKnownTelegramSenderForTest(
  project: { metadata: unknown },
  message: TelegramMessage,
): boolean {
  const senderId = message.from?.id;
  if (senderId === undefined || senderId === null) return false;
  const metadata = project.metadata as
    | { telegram?: { allowedUserIds?: unknown } }
    | null
    | undefined;
  const allowedUserIds = metadata?.telegram?.allowedUserIds;
  if (!Array.isArray(allowedUserIds)) return false;
  return allowedUserIds.some((id) => String(id) === String(senderId));
}

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
      // Forget EVERYTHING that would make the next message resume this chat's
      // session instead of starting a fresh one:
      //  - chat_threads: the chat→session mapping (else the next msg follows up)
      //  - chat_event_dedup: the create-claim (a lingering claim strands the
      //    next create behind an 8s wait for a mapping that never comes)
      //  - session_lifecycle_commands: the createSession idempotency record —
      //    its key is a CONSTANT per chat (telegram:threadcreate:bot:chat), so
      //    without this delete createSession replays the SAME (now-dead) session
      //    forever and /new does nothing.
      const claimKey = threadClaimKey(botId, chatId);
      await db
        .delete(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'telegram'),
            eq(chatThreads.workspaceId, botId),
            eq(chatThreads.threadId, chatId),
          ),
        );
      await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claimKey));
      await db
        .delete(sessionLifecycleCommands)
        .where(eq(sessionLifecycleCommands.idempotencyKey, claimKey));
      await telegramSendMessage(token, message.chat.id, TELEGRAM_NEW_TEXT, {
        replyToMessageId: message.message_id,
      });
      return;
    }
    if (command.command === 'status') {
      await telegramSendMessage(
        token,
        message.chat.id,
        await renderChatStatus(projectId, botId, botUsername, chatId),
        { parseMode: 'HTML', replyToMessageId: message.message_id, disableWebPagePreview: true },
      );
      return;
    }
    if (command.command === 'agent') {
      await postTelegramAgentPicker(projectId, botId, chatId, message.message_id);
      return;
    }
    if (command.command === 'model') {
      await postTelegramModelPicker(projectId, botId, chatId, message.message_id);
      return;
    }
    // /start <code> is the pairing handshake (deep links t.me/<bot>?start=<code>
    // arrive in exactly this shape) — it must work for UNPAIRED senders, which
    // is why commands are handled before the allowlist gate.
    const reply =
      command.command === 'start'
        ? command.args
          ? await attemptTelegramPairing(projectId, message, command.args)
          : (await telegramSenderLocked(projectId, message))
            ? TELEGRAM_LOCKED_TEXT
            : TELEGRAM_START_TEXT
        : TELEGRAM_HELP_TEXT;
    await telegramSendMessage(token, message.chat.id, reply, {
      replyToMessageId: message.message_id,
    });
    return;
  }

  await createOrJoinChatSession({ projectId, botId, botUsername, chatId, message });
}

// Post the one-time group intro when the bot is freshly added to a group.
async function handleMyChatMember(
  projectId: string,
  update: TelegramChatMemberUpdate,
): Promise<void> {
  if (!botJustAddedToGroup(update)) return;
  const token = await loadTelegramTokenForProject(projectId);
  if (!token) return;
  await telegramSendMessage(token, update.chat.id, TELEGRAM_GROUP_WELCOME_TEXT);
}

// An inline-keyboard tap answering the agent's `question` tool. We recover the
// chosen option's LABEL from the message's own echoed keyboard (no storage),
// ack the tap to clear its spinner, then deliver the label into the session as
// an ordinary follow-up message — identical to the user typing that answer.
async function handleCallbackQuery(projectId: string, cb: TelegramCallbackQuery): Promise<void> {
  const install = await loadTelegramInstall(projectId);
  if (!install) return;
  const { botId, botUsername } = install;
  const token = await loadTelegramTokenForProject(projectId);
  const cbMessage = cb.message;

  // Review-card taps (Approve / Reject / Ask-for-changes): apply the verdict as
  // the project's automation actor, then resume the session with the decision.
  // Gated by the allowlist — an unpaired tapper can't decide reviews.
  if (isReviewCallback(cb.data) && cbMessage?.chat) {
    const chatId = String(cbMessage.chat.id);
    const [project] = await db
      .select({ accountId: projects.accountId, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project) {
      if (token) await telegramAnswerCallbackQuery(token, cb.id);
      return;
    }
    const syntheticTap: TelegramMessage = {
      message_id: cbMessage.message_id,
      chat: cbMessage.chat,
      from: cb.from,
      text: '',
    };
    if (
      telegramRequireUserIdentityForTest() &&
      !isKnownTelegramSenderForTest(project, syntheticTap)
    ) {
      if (token) {
        await telegramAnswerCallbackQuery(token, cb.id, 'Pair with the bot first (/start <code>).');
      }
      return;
    }
    const actorUserId = await resolveProjectAutomationActor(project.accountId);
    const result = actorUserId
      ? await applyTelegramReviewVerdict(projectId, cb.data, actorUserId)
      : null;
    if (token) await telegramAnswerCallbackQuery(token, cb.id, result?.toast ?? 'Done');
    if (result?.decisionLine) {
      if (token) {
        await telegramEditMessageText(
          token,
          chatId,
          cbMessage.message_id,
          `✅ ${result.toast}`,
        ).catch(() => {});
      }
      // Resume the agent from the decision — same follow-up path as a typed reply.
      await createOrJoinChatSession({
        projectId,
        botId,
        botUsername,
        chatId,
        message: { ...syntheticTap, text: result.decisionLine },
      });
    }
    return;
  }

  // /agent · /model picker taps: change the chat's binding (same allowlist gate
  // as running a turn — an unpaired tapper can't reconfigure the chat).
  if (isControlCallback(cb.data) && cbMessage?.chat) {
    const chatId = String(cbMessage.chat.id);
    const syntheticTap: TelegramMessage = {
      message_id: cbMessage.message_id,
      chat: cbMessage.chat,
      from: cb.from,
      text: '',
    };
    if (await telegramSenderLocked(projectId, syntheticTap)) {
      if (token)
        await telegramAnswerCallbackQuery(token, cb.id, 'Pair with the bot first (/start <code>).');
      return;
    }
    const result = await applyControlPick(botId, chatId, cb.data);
    if (token) {
      await telegramAnswerCallbackQuery(token, cb.id, result?.toast ?? 'Done');
      // Collapse the picker into its outcome (drop the keyboard).
      if (result) {
        await telegramEditMessageText(
          token,
          chatId,
          cbMessage.message_id,
          `✅ ${result.toast}`,
        ).catch(() => {});
      }
    }
    return;
  }

  // Multi-select question: a checkbox toggle just repaints the keyboard (state
  // lives in the message); no gate — nothing runs until Submit.
  if (isToggleCallback(cb.data) && cbMessage?.chat) {
    const next = toggleKeyboardOption(cbMessage.reply_markup?.inline_keyboard, cb.data);
    if (token) {
      if (next) {
        await telegramEditMessageReplyMarkup(
          token,
          cbMessage.chat.id,
          cbMessage.message_id,
          next,
        ).catch(() => {});
      }
      await telegramAnswerCallbackQuery(token, cb.id);
    }
    return;
  }

  // Multi-select Submit: gather the checked labels and deliver them as one
  // answer (the create-or-join path re-runs the allowlist gate).
  if (isSubmitCallback(cb.data) && cbMessage?.chat) {
    const labels = selectedLabelsFromKeyboard(cbMessage.reply_markup?.inline_keyboard);
    if (labels.length === 0) {
      if (token) await telegramAnswerCallbackQuery(token, cb.id, 'Pick at least one option first.');
      return;
    }
    if (token) {
      await telegramAnswerCallbackQuery(token, cb.id, `✓ ${labels.length} selected`);
      await telegramEditMessageReplyMarkup(
        token,
        cbMessage.chat.id,
        cbMessage.message_id,
        null,
      ).catch(() => {});
    }
    await createOrJoinChatSession({
      projectId,
      botId,
      botUsername,
      chatId: String(cbMessage.chat.id),
      message: {
        message_id: cbMessage.message_id,
        chat: cbMessage.chat,
        from: cb.from,
        text: labels.join(', '),
      },
    });
    return;
  }

  // Only single-select question taps are handled beyond this point; anything
  // else gets a silent ack so the client stops spinning.
  const answer = isQuestionCallback(cb.data)
    ? answerLabelFromKeyboard(cbMessage?.reply_markup?.inline_keyboard, cb.data)
    : null;
  if (!answer || !cbMessage?.chat) {
    if (token) await telegramAnswerCallbackQuery(token, cb.id);
    return;
  }

  // Ack immediately (clears the button spinner + shows a toast) — best-effort,
  // independent of whether the session routing below succeeds.
  if (token) await telegramAnswerCallbackQuery(token, cb.id, `✓ ${answer}`);

  // Route the answer as a follow-up message. Synthesize a TelegramMessage from
  // the tapper + the question's chat so the SAME create-or-join path (and its
  // allowlist gate) runs — a tap from an unpaired user is rejected exactly like
  // a typed message would be.
  const synthetic: TelegramMessage = {
    message_id: cbMessage.message_id,
    chat: cbMessage.chat,
    from: cb.from,
    text: answer,
  };
  await createOrJoinChatSession({
    projectId,
    botId,
    botUsername,
    chatId: String(cbMessage.chat.id),
    message: synthetic,
  });
}

// Gather the chat's effective routing (project name + agent/model/policy
// overrides + paired-user count) and render it for /status. All reads —
// nothing here mutates.
async function renderChatStatus(
  projectId: string,
  botId: string,
  botUsername: string | null,
  chatId: string,
): Promise<string> {
  const [selection, [project]] = await Promise.all([
    currentChannelSelection({ platform: 'telegram', teamId: botId, channelId: chatId }),
    db
      .select({ name: projects.name, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1),
  ]);
  return renderTelegramStatus({
    botUsername,
    projectName: project?.name ?? null,
    agentName: selection?.agentName ?? null,
    model: selection?.opencodeModel ?? null,
    conversationPolicy: selection?.conversationPolicy ?? null,
    pairedUserCount: telegramAllowedUserIds(project?.metadata).length,
  });
}

// `/start <code>`: validate the dashboard-minted single-use code and allowlist
// the sender in projects.metadata.telegram.allowedUserIds. Failure is one
// generic message — never confirm whether a code exists, is expired, or is
// merely wrong.
async function attemptTelegramPairing(
  projectId: string,
  message: TelegramMessage,
  presented: string,
): Promise<string> {
  const senderId = message.from?.id;
  if (senderId === undefined || senderId === null) return TELEGRAM_PAIRING_FAILED_TEXT;

  const pairing = await loadTelegramPairing(projectId);
  if (!pairing || !telegramPairingMatches(pairing, presented, new Date())) {
    console.warn('[telegram-webhook] pairing attempt rejected', { projectId, senderId });
    return TELEGRAM_PAIRING_FAILED_TEXT;
  }

  const [project] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return TELEGRAM_PAIRING_FAILED_TEXT;

  await db
    .update(projects)
    .set({ metadata: addTelegramAllowedUser(project.metadata, senderId) })
    .where(eq(projects.projectId, projectId));
  // Clear BEFORE replying: even if the ack fails, the code must not be
  // replayable by a second sender.
  await clearTelegramPairing(projectId);
  console.log('[telegram-webhook] paired sender', { projectId, senderId });
  return TELEGRAM_PAIRED_TEXT;
}

/** Whether the identity gate would reject this sender — drives the /start
 *  reply (pairing instructions vs the normal intro). */
async function telegramSenderLocked(projectId: string, message: TelegramMessage): Promise<boolean> {
  if (!telegramRequireUserIdentityForTest()) return false;
  const [project] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return true;
  return !isKnownTelegramSenderForTest(project, message);
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

  // Sessions run as the project's automation actor; the allowlist gate below
  // decides which Telegram senders may trigger them. Pairing (/start <code>,
  // handled before this) is how senders get onto the allowlist.
  if (telegramRequireUserIdentityForTest() && !isKnownTelegramSenderForTest(project, message)) {
    console.warn(
      '[telegram-webhook] rejecting unbound sender for project',
      projectId,
      message.from?.id,
    );
    // Tell the human how to pair instead of ghosting them — private chats
    // only (a group hint would answer arbitrary bystanders), throttled via
    // the dedup table so a chatty stranger can't turn us into a reply bot.
    if (message.chat.type === 'private' && message.from?.id != null) {
      const hintKey = `telegram:pairhint:${botId}:${chatId}:${message.from.id}`;
      if (await claimOnce(hintKey)) {
        const token = await loadTelegramTokenForProject(projectId);
        if (token) {
          await telegramSendMessage(token, message.chat.id, TELEGRAM_LOCKED_TEXT, {
            replyToMessageId: message.message_id,
          }).catch(() => {});
        }
      }
    }
    return;
  }

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
      console.warn(
        '[telegram-webhook] lost chat-create claim but winner never published a session',
        {
          botId,
          chatId,
        },
      );
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
