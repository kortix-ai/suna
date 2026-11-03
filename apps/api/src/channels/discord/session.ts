/**
 * Discord as a channel connector. The Gateway intake (gateway.ts) stores each
 * message written to the bot, and the interactions webhook (inbound.ts) each
 * slash command and button press, in the integration event inbox; this
 * consumer turns them into session turns through the conversation core
 * (channels/core/conversation.ts):
 *
 *   unknown sender  → a pairing reply naming their user id, no session (fail closed),
 *                     and an access request an admin can allow; in a thread, a message
 *                     not written to the bot is ignored
 *   a mention       → in a channel that takes threads, Kortix starts a thread on the
 *                     message: the thread is the conversation, one session
 *   a command       → `/help`, `/status`, `/new`, `/stop`, `/model`, `/agent`, as a slash
 *                     command or typed after a mention, run in the core (core/commands.ts)
 *                     and answered in the conversation, with a menu where the reply offers one
 *   anything else   → the core: a follow-up into the conversation's session, or a new
 *                     project-visible session bound to it; the message's files go with it
 *   a press         → a command menu's pick or button (`kc:`) runs its command; a question
 *                     button (`kq:`) answers the agent's question (core/questions.ts),
 *                     one question at a time; so does a message typed while one shows;
 *                     a project button (`kd:`) binds the channel (`/connect`)
 *
 * The agent answers through the `kortix_discord` connector (connectors/channels.ts);
 * the bot token never enters the sandbox.
 */
import { projectSessions, projects } from '@kortix/db';
import type { ChannelEnvelope } from '@kortix/shared';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { DISCORD_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { gateSender, refusedPressText } from '../core/channel-access';
import { CHANNEL_COMMANDS, parseChannelCommand, type ParsedCommand } from '../core/command-list';
import { isCommandPressData } from '../core/command-press';
import { type CommandReply, rememberCommandMenu, runChannelCommand, runCommandPress } from '../core/commands';
import {
  type ChannelFile,
  type ChannelMessage,
  type ChannelNotice,
  type ChannelPort,
  type ChannelTarget,
  routeChannelMessage,
} from '../core/conversation';
import { chatSessionStart, chatTurnModel } from '../core/model-choice';
import { connectorReply } from '../core/prompt';
import {
  answerQuestionInChat,
  clearQuestionButtons,
  handleQuestionTap,
  type QuestionPort,
  questionPicksSoFar,
} from '../core/questions';
import { registerSessionPort } from '../core/session-notice';
import { claimThreadCreate } from '../core/threads';
import type { SettingsChannel } from '../core/settings';
import { classifyTurnError } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { DISCORD_START_ERROR_COMMANDS, startErrorMessage } from '../start-error';
import { discordAccessPort } from './access';
import { DiscordApiError, discordCall, discordDownload, discordUnreachable } from './api';
import { bindDiscordChannel, claimDiscordChannel, isProjectPress, parseProjectPress } from './connect';
import { loadDiscordInstall } from './installs';
import {
  clip,
  COMMAND_SELECT_ID,
  DISCORD_MESSAGE_CHARS,
  type DiscordMessageBody,
  discordCommandMessage,
  discordQuestionFooter,
  discordQuestionMessage,
} from './render';
import {
  DISCORD_INTERACTION_EVENT,
  type DiscordConversation,
  type DiscordInteractionEventData,
  type DiscordMessageEventData,
  type DiscordStoredInteraction,
  type DiscordStoredMessage,
} from './types';

/** Discord's error for a thread start on a message that already has one: a retry's. */
const THREAD_ALREADY_CREATED = 160004;
/** `MessageFlags.EPHEMERAL`: only the person who used the command or button sees the reply. */
const EPHEMERAL = 64;
/** `MessageFlags.IS_VOICE_MESSAGE`. */
const VOICE_MESSAGE = 8192;

// ── Posting ──────────────────────────────────────────────────────────────────

/** Discord's code for a write into an archived thread. */
const THREAD_ARCHIVED = 50083;
/** An interaction token that expired (15 minutes) or is unknown. */
const TOKEN_GONE = new Set([10015, 50027]);

/**
 * A write into a thread that archived after a week idle unarchives it once and
 * tries again; a locked thread stays refused.
 */
async function intoThread<T>(channelId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof DiscordApiError) || error.code !== THREAD_ARCHIVED) throw error;
    await discordCall('PATCH /channels/{id}', `/channels/${channelId}`, { method: 'PATCH', body: { archived: false } });
    return write();
  }
}

/** Post into a channel or thread. Returns the message id; null when Discord refused it (logged). */
async function postMessage(channelId: string, body: Partial<DiscordMessageBody>, replyTo?: string): Promise<string | null> {
  return intoThread(channelId, () =>
    discordCall<{ id: string }>('POST /channels/{id}/messages', `/channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        ...body,
        allowed_mentions: { parse: [] },
        ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
      },
    }),
  ).then(
    (sent) => sent.id,
    (error) => {
      logger.warn('[discord] reply failed', { error: String(error) });
      return null;
    },
  );
}

async function editMessage(channelId: string, messageId: string, body: Partial<DiscordMessageBody>): Promise<void> {
  await intoThread(channelId, () =>
    discordCall('PATCH /channels/{id}/messages/{id}', `/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      body: { ...body, allowed_mentions: { parse: [] } },
    }),
  );
}

/**
 * The reply to a deferred slash command (the webhook answered type 5). Returns the message id.
 * An expired token (the command waited over 15 minutes behind its conversation) posts the
 * reply in the channel instead, so it is never lost.
 */
async function editInteractionReply(token: string, body: Partial<DiscordMessageBody>, channelId?: string): Promise<string | null> {
  return discordCall<{ id: string }>(
    'PATCH /webhooks/{app}/{token}/messages/@original',
    `/webhooks/${config.DISCORD_APPLICATION_ID}/${token}/messages/@original`,
    { method: 'PATCH', auth: false, body: { ...body, allowed_mentions: { parse: [] } } },
  ).then(
    (sent) => sent.id,
    async (error) => {
      if (channelId && error instanceof DiscordApiError && (TOKEN_GONE.has(error.code) || error.status === 401)) {
        return postMessage(channelId, body);
      }
      logger.warn('[discord] command reply not drawn', { error: String(error) });
      return null;
    },
  );
}

/** A notice only the presser sees, after the webhook's deferred update (type 6). Never throws. */
export async function ephemeralFollowUp(token: string, content: string): Promise<void> {
  await discordCall('POST /webhooks/{app}/{token}', `/webhooks/${config.DISCORD_APPLICATION_ID}/${token}`, {
    method: 'POST',
    auth: false,
    body: { content: clip(content, DISCORD_MESSAGE_CHARS), flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  }).catch((error) => logger.warn('[discord] press notice not sent', { error: String(error) }));
}

/** "typing…" for about 10 seconds. Never throws. */
async function showTyping(channelId: string): Promise<void> {
  await discordCall('POST /channels/{id}/typing', `/channels/${channelId}/typing`, { method: 'POST' }).catch(() => undefined);
}

// ── The port ─────────────────────────────────────────────────────────────────

/**
 * The agent's questions (core/questions.ts), posted as the agent would post them
 * with `send_message`. A message ref is the Discord message id. A tap's notice
 * is an ephemeral follow-up on its interaction (the tap id is the interaction token).
 */
const discordQuestions: QuestionPort = {
  maxButtons: CHANNELS.discord.buttons.max,
  agentCall: (target, m) => ({
    slug: DISCORD_CHANNEL_CONNECTOR_SLUG,
    actionPath: 'send_message',
    args: { channel_id: target.threadId, ...discordQuestionMessage(m) },
  }),
  async send(target, m) {
    const sent = await intoThread(target.threadId, () =>
      discordCall<{ id: string }>('POST /channels/{id}/messages', `/channels/${target.threadId}/messages`, {
        method: 'POST',
        body: { ...discordQuestionMessage(m), allowed_mentions: { parse: [] } },
      }),
    );
    return sent.id;
  },
  async edit(target, ref, m) {
    await editMessage(target.threadId, ref, m ? discordQuestionMessage(m) : { components: [] });
  },
  async answerTap(tap, reply) {
    if (reply) await ephemeralFollowUp(tap.id, discordQuestionFooter(reply));
  },
};

/** Plain-text next step per `classifyTurnError` title (slack/errors.ts). Another title ('Run failed') gets the fallback. */
const RUN_ERROR_ADVICE: Partial<Record<string, string>> = {
  'Out of credits': 'A workspace admin can top up credits in Kortix. Then send your message again.',
  'Usage limit reached': 'Wait, then send your message again. A project admin can also pick another model in Kortix.',
  'Response too long': 'Ask the agent to continue, or narrow the request.',
  'Conversation too long': 'Use /new to start a new conversation.',
  'Agent unavailable': 'Use /agent to pick another agent, then /new and your message again. A project admin can also fix the agent in Kortix.',
  'Model unavailable': 'Use /model to pick another model, then send your message again.',
  'ChatGPT login needs reconnection': 'Whoever connected the ChatGPT account must reconnect it in Kortix. Then send your message again.',
  'Provider rejected the request': 'A workspace admin can check the model provider settings in Kortix. Then send your message again.',
  'Provider unavailable': 'Send your message again to retry.',
  'Request blocked': 'Rephrase the request, then send it again.',
};
const RUN_ERROR_FALLBACK_ADVICE = 'Send your message again, or use /new to start a new conversation.';

/** The conversation's settings row key (`chat_channel_bindings`): a thread's parent channel, or the DM. */
const discordSettings = (target: ChannelTarget, settingsId: string): SettingsChannel => ({
  platform: 'discord',
  teamId: target.workspaceId,
  channelId: settingsId,
});

/**
 * The settings row of a session's conversation: a thread keeps its parent
 * channel's, which the session's metadata names (`discord.channel_id`).
 */
async function settingsOfSession(target: ChannelTarget, sessionId: string): Promise<SettingsChannel> {
  const [row] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  const channelId = (row?.metadata as { discord?: { channel_id?: unknown } } | null)?.discord?.channel_id;
  return discordSettings(target, typeof channelId === 'string' && channelId ? channelId : target.threadId);
}

export const discordPort: ChannelPort & { questions: QuestionPort } = {
  async notify(target, notice) {
    const text = discordNotice(target, notice);
    if (text) await postMessage(target.threadId, { content: clip(text, DISCORD_MESSAGE_CHARS) }, target.messageId);
  },
  questions: discordQuestions,
  turnModel: async (target, thread) => chatTurnModel(await settingsOfSession(target, thread.sessionId), thread),
};

/** The conversation's words for a notice; null says nothing. */
export function discordNotice(target: ChannelTarget, notice: ChannelNotice): string | null {
  switch (notice.kind) {
    case 'create_pending':
      return 'Kortix is still starting a session for this conversation. The agent replies here when it is ready.';
    case 'create_in_flight':
      return 'Kortix is still starting a session for this conversation. Send your message again in a minute.';
    case 'create_failed':
      return startErrorMessage(notice.error.status, notice.error.body, DISCORD_START_ERROR_COMMANDS);
    case 'follow_up_failed':
      return "This conversation's Kortix session cannot take new messages. Use /new to start a new conversation, then send your message again.";
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
        `Kortix could not start this conversation's session yet. ${notice.reason}`,
        'Kortix tries again automatically for a few minutes. If the agent does not reply, use /new, then send your message again.',
      ].join('\n');
    case 'start_failed':
      return [
        `Kortix could not start this conversation's session, so the agent did not run.${notice.reason ? ` ${notice.reason}` : ''}`,
        'Use /new, then send your message again. If it fails again, a project admin can check the session in Kortix.',
        `Details: ${sessionWebUrl(config.FRONTEND_URL, target.projectId, notice.sessionId)}`,
      ].join('\n');
  }
}

// ── A message ────────────────────────────────────────────────────────────────

/** Each kind of file, by its declared type: Kortix's word for it (also the session-view label). */
function fileKind(a: { content_type?: string; duration_secs?: number }, voice: boolean): string {
  const type = a.content_type ?? '';
  if (voice && type.startsWith('audio/')) return 'voice message';
  if (type.startsWith('image/')) return 'photo';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'document';
}

/** The message's own files, never a replied-to message's. */
export function discordFiles(message: DiscordStoredMessage): ChannelFile[] {
  const voice = ((message.flags ?? 0) & VOICE_MESSAGE) !== 0;
  return message.attachments.map((a) => ({
    kind: fileKind(a, voice),
    name: a.filename,
    mime: a.content_type || 'application/octet-stream',
    size: a.size,
    read: (maxBytes) => discordDownload(a.url, maxBytes),
  }));
}

/** `<@id>` and `<@!id>` as `@name`: the bot's own mention goes, another user's shows their name. */
function mentionsAsNames(content: string, message: DiscordStoredMessage, botUserId: string): string {
  return content.replace(/<@!?(\d{17,20})>/g, (raw, id: string) => {
    if (id === botUserId) return '';
    const user = message.mentions.find((u) => u.id === id);
    return user?.username ? `@${user.username}` : raw;
  });
}

/**
 * The sender's words: the content, else a label for each file or sticker. A named file keeps
 * its label under the content, so its name reaches the agent in the sender's own (untrusted) text.
 */
export function discordText(message: DiscordStoredMessage, botUserId: string): string {
  const content = mentionsAsNames(message.content, message, botUserId).trim();
  const voice = ((message.flags ?? 0) & VOICE_MESSAGE) !== 0;
  const labels = [
    ...message.attachments.map((a) => {
      const kind = fileKind(a, voice);
      return kind === 'voice message' && a.duration_secs ? `(voice message, ${Math.round(a.duration_secs)} s)` : `(${kind === 'document' ? 'file' : kind} ${a.filename})`;
    }),
    ...message.stickers.map((s) => `(sticker ${s})`),
  ];
  if (content) return labels.length ? `${content}\n${labels.join('\n')}` : content;
  return labels.join('\n') || '(no text)';
}

/** What a person reads as the sender: the server nickname, else the display name, then the username. */
function senderName(user: { username?: string; global_name?: string | null }, nick?: string | null): string {
  const shown = nick || user.global_name;
  if (shown && user.username) return `${shown} (@${user.username})`;
  return shown || (user.username ? `@${user.username}` : 'unknown');
}

/** "/new, /stop, … and /help": the commands the agent never receives. */
const COMMAND_NAMES = CHANNEL_COMMANDS.map((c) => `/${c.name}`);
const KORTIX_COMMANDS = `${COMMAND_NAMES.slice(0, -1).join(', ')} and ${COMMAND_NAMES.at(-1)}`;

/** Where a conversation is, for the prompt header and the Channels page. */
function discordWhere(c: DiscordConversation): string {
  if (c.direct) return 'direct message';
  const channel = c.channelName ? `#${c.channelName}` : `channel ${c.settingsId}`;
  return c.threadName && c.threadId !== c.settingsId ? `${c.threadName} (thread in ${channel})` : channel;
}

/**
 * One message for the agent and the session view: the core renders it
 * (`channelPromptText`). A press's answer has no message of its own: `text` is the answer.
 */
export function discordEnvelope(
  conversation: DiscordConversation,
  sender: { user: DiscordStoredMessage['author']; nick?: string | null },
  text: string,
  messageId: string,
): ChannelEnvelope {
  const { threadId } = conversation;
  return {
    platform: CHANNELS.discord.envelope,
    sender: senderName(sender.user, sender.nick),
    where: discordWhere(conversation),
    text,
    reply: connectorReply(DISCORD_CHANNEL_CONNECTOR_SLUG, 'send_message', { channel_id: threadId, content: '<reply>' }),
    notes: [
      `Channel ${threadId}${conversation.direct ? ' (direct message)' : conversation.threadId !== conversation.settingsId ? ` (a thread of channel ${conversation.settingsId})` : ''}, sender id ${sender.user.id}, message id ${messageId}.`,
      `One message holds at most ${CHANNELS.discord.messageChars} characters; send a longer answer as several messages.`,
      'Discord shows Markdown: **bold**, *italic*, `code`, ```code blocks```, > quotes and lists.',
      'Whenever you need the user to choose or to answer, call your question tool, with every question in one call: Kortix shows them in this conversation as buttons, one question at a time.',
      'Never list choices or questions as plain text. Ask in plain words only when the tool result says the question could not be posted.',
      `While you work on a long task, show typing: ${connectorReply(DISCORD_CHANNEL_CONNECTOR_SLUG, 'trigger_typing', { channel_id: threadId })}.`,
      'The bot token is resolved server-side. Do not look for it in the sandbox.',
      conversation.direct || config.DISCORD_MESSAGE_CONTENT
        ? `The next message in this conversation continues this session. Kortix answers ${KORTIX_COMMANDS} itself; those commands never reach you.`
        : `The next message that mentions you in this thread continues this session; people's other messages there do not reach you. Kortix answers ${KORTIX_COMMANDS} itself; those commands never reach you.`,
    ],
  };
}

const createClaimOf = (projectId: string, target: Pick<ChannelTarget, 'workspaceId' | 'threadId'>) =>
  `discord:threadcreate:${projectId}:${target.workspaceId}:${target.threadId}`;

/**
 * The thread a mention starts: on the message, so its id is the message's. A retry finds it made.
 * False: Discord refused (no permission to start threads there); the sender is told.
 */
async function startThread(message: DiscordStoredMessage, conversation: DiscordConversation, botUserId: string): Promise<boolean> {
  const name = clip(mentionsAsNames(message.content, message, botUserId).replace(/\s+/g, ' ').trim() || 'Kortix', 100);
  try {
    await discordCall('POST /channels/{id}/messages/{id}/threads', `/channels/${message.channel_id}/messages/${message.id}/threads`, {
      method: 'POST',
      // A week idle before it archives; a message unarchives it.
      body: { name, auto_archive_duration: 10080 },
    });
    return true;
  } catch (error) {
    if (error instanceof DiscordApiError && error.code === THREAD_ALREADY_CREATED) return true;
    if (discordUnreachable(error)) throw error;
    logger.warn('[discord] thread not started', { error: String(error) });
    await postMessage(
      conversation.settingsId,
      {
        content:
          'Kortix could not start a thread for your message. A server admin can give the Kortix app the Create Public Threads and Send Messages in Threads permissions in this channel.',
      },
      message.id,
    );
    return false;
  }
}

/** The project row, or null for a project deleted since the message was stored. */
async function loadProject(projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return project ?? null;
}

/** The project's install, when it is still the guild the conversation was routed through. */
async function installFor(projectId: string, conversation: DiscordConversation) {
  const install = await loadDiscordInstall(projectId);
  return install && install.guildId === conversation.guildId ? install : null;
}

export async function handleDiscordMessage(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  const { message, conversation, botUserId } = event.data as unknown as DiscordMessageEventData;
  const project = await loadProject(event.projectId);
  const install = project && (await installFor(event.projectId, conversation));
  if (!project || !install) return;

  const target: ChannelTarget = {
    platform: 'discord',
    workspaceId: conversation.guildId,
    threadId: conversation.threadId,
    projectId: event.projectId,
    messageId: message.id,
  };
  const reply = (content: string) => postMessage(conversation.startThread ? conversation.settingsId : target.threadId, { content }, message.id);

  if (!install.allowedUserIds.includes(message.author.id)) {
    // A thread's other messages are its people talking: only a message written to the bot hears why not.
    if (!conversation.addressed) return;
    const refusal = await gateSender(discordAccessPort, {
      projectId: event.projectId,
      scopeId: install.guildId,
      lists: install,
      senderId: message.author.id,
      direct: true,
      from: message.author,
    });
    // In a server the reply is public: once an hour per person, however often they mention the app. A DM always hears it.
    const once = conversation.direct || (await claimThreadCreate(`discord:refused:${conversation.guildId}:${message.author.id}`, 60 * 60_000).catch(() => null));
    if (refusal && once) await reply(refusal);
    return;
  }

  const text = discordText(message, botUserId);
  // "@Kortix" alone: no session for nothing. A file or a sticker is something.
  if (!mentionsAsNames(message.content, message, botUserId).trim() && !message.attachments.length && !message.stickers.length) {
    await reply(
      message.viaRole
        ? 'You mentioned the Kortix role, so Discord did not show me your message. Mention the app itself: pick @Kortix with the app badge, not the role.'
        : 'Mention me with what you need, for example: @Kortix summarize this thread. /help lists the commands.',
    );
    return;
  }
  const command = parseChannelCommand(mentionsAsNames(message.content, message, botUserId).trim(), null);
  const settings = discordSettings(target, conversation.settingsId);
  if (command) {
    // A command written in a channel works on the channel: its settings, no session.
    const commandTarget = conversation.startThread ? { ...target, threadId: conversation.settingsId } : target;
    await runCommand(
      { target: commandTarget, project, settings, conversation, droppedFile: message.attachments.length ? 'file' : undefined },
      command,
      async (body) => {
        const sent = await postMessage(commandTarget.threadId, body, message.id);
        if (sent && body.components.length) await rememberCommandMenu(commandTarget, sent);
      },
    );
    return;
  }

  if (conversation.startThread && !(await startThread(message, conversation, botUserId))) return;
  await claimDiscordChannel(conversation, event.projectId);
  const files = discordFiles(message);
  // A question shown one at a time takes a typed answer; a message with a file is never one.
  if (!files.length && (await answerQuestionInChat(discordPort, target, { id: `message:${event.id}`, text }, answerFollowUp(event, conversation, message.author, message.nick), run))) {
    return;
  }
  // The message carries the answers given so far on a question it ends. Read
  // before it routes and cleared after, so a retry carries them again.
  const picks = await questionPicksSoFar(target);
  const envelope = discordEnvelope(conversation, { user: message.author, nick: message.nick }, text, message.id);
  await showTyping(target.threadId);

  await routeChannelMessage(
    discordPort,
    {
      target,
      keys: {
        followUp: `discord:${conversation.guildId}:${event.id}`,
        create: `discord:create:${conversation.guildId}:${event.id}`,
        createClaim: createClaimOf(event.projectId, target),
      },
      followUp: picks ? { ...envelope, text: `${picks}\n\n${envelope.text}` } : envelope,
      files,
      plan: async () => {
        const start = await chatSessionStart(settings, project).catch((error) => {
          logger.warn('[discord] chat settings unreadable; the session starts on the defaults', { projectId: event.projectId, error: String(error) });
          return { agentName: 'default' } as Awaited<ReturnType<typeof chatSessionStart>>;
        });
        if (start.unavailableModel) {
          await postMessage(
            target.threadId,
            { content: `Kortix did not send your message: this channel's model ${start.unavailableModel} is not available any more. Pick another with /model, then send your message again.` },
            message.id,
          );
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
            discord: {
              guild_id: conversation.direct ? null : conversation.guildId,
              channel_id: conversation.settingsId,
              thread_id: conversation.threadId,
              author_id: message.author.id,
              message_id: message.id,
            },
          },
          // A new session never asked the questions: the message alone.
          prompt: envelope,
        };
      },
    },
    run,
  );
  await clearQuestionButtons(discordQuestions, target, 'answered_in_chat');
}

/** An answer to the agent's question, as a follow-up under the key of the event (a press or a typed message) that gave it. */
function answerFollowUp(
  event: IntegrationEvent,
  conversation: DiscordConversation,
  user: DiscordStoredMessage['author'],
  nick?: string | null,
): (threadId: string, answer: string) => Pick<ChannelMessage, 'keys' | 'followUp'> {
  return (threadId, answer) => ({
    keys: {
      followUp: `discord:${conversation.guildId}:${event.id}`,
      create: `discord:create:${conversation.guildId}:${event.id}`,
      createClaim: createClaimOf(event.projectId, { workspaceId: conversation.guildId, threadId }),
    },
    followUp: discordEnvelope({ ...conversation, threadId }, { user, nick }, answer, event.id),
  });
}

// ── Commands ─────────────────────────────────────────────────────────────────

interface DiscordCommandContext {
  target: ChannelTarget;
  project: NonNullable<Awaited<ReturnType<typeof loadProject>>>;
  settings: SettingsChannel;
  conversation: DiscordConversation;
  droppedFile?: string;
}

function commandContext(ctx: DiscordCommandContext) {
  return {
    target: ctx.target,
    project: ctx.project,
    settings: ctx.settings,
    label: { name: discordWhere(ctx.conversation), type: ctx.conversation.direct ? 'dm' : 'channel' },
    createClaim: createClaimOf(ctx.project.projectId, ctx.target),
    questions: discordQuestions,
    ...(ctx.droppedFile ? { droppedFile: ctx.droppedFile } : {}),
  };
}

async function runCommand(ctx: DiscordCommandContext, command: ParsedCommand, send: (body: DiscordMessageBody) => Promise<void>): Promise<void> {
  await runChannelCommand(commandContext(ctx), command, (reply: CommandReply) => send(discordCommandMessage(reply)));
}

// ── An interaction ───────────────────────────────────────────────────────────

/**
 * A slash command or a press, already answered by the webhook (a deferred reply,
 * or a deferred update). From an allowed user, a slash command runs and draws its
 * reply over the deferred one; a command menu's pick or button (`kc:`) runs its
 * command over the pressed message; a question button (`kq:`) answers the
 * question; a project button (`kd:`) binds the channel. Anyone else hears why not,
 * in a notice only they see.
 */
export async function handleDiscordInteraction(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  const { interaction, conversation } = event.data as unknown as DiscordInteractionEventData;
  const project = await loadProject(event.projectId);
  const install = project && (await installFor(event.projectId, conversation));
  const press = interaction.type === 3;
  if (!project || !install) {
    const gone = 'This channel is not connected to a Kortix project any more. Use /connect to pick one.';
    return void (press ? await ephemeralFollowUp(interaction.token, gone) : await editInteractionReply(interaction.token, { content: gone }));
  }
  if (!install.allowedUserIds.includes(interaction.user.id)) {
    const refused = refusedPressText(discordAccessPort, interaction.user.id);
    return void (press ? await ephemeralFollowUp(interaction.token, refused) : await editInteractionReply(interaction.token, { content: refused }));
  }
  const target: ChannelTarget = {
    platform: 'discord',
    workspaceId: conversation.guildId,
    threadId: conversation.threadId,
    projectId: event.projectId,
    ...(interaction.message_id ? { messageId: interaction.message_id } : {}),
  };
  const ctx: DiscordCommandContext = { target, project, settings: discordSettings(target, conversation.settingsId), conversation };

  if (!press) {
    const spec = CHANNEL_COMMANDS.find((c) => c.name === interaction.command?.name);
    if (!spec) return void (await editInteractionReply(interaction.token, { content: 'Kortix does not know this command.' }));
    await runCommand(ctx, { name: spec.name, arg: interaction.command?.arg ?? '' }, async (body) => {
      const sent = await editInteractionReply(interaction.token, body, conversation.threadId);
      if (sent && body.components.length) await rememberCommandMenu(target, sent);
    });
    return;
  }

  const data = interaction.custom_id ?? '';
  const ref = interaction.message_id ?? '';
  if (isProjectPress(data)) {
    const projectId = parseProjectPress(data);
    const done = projectId === event.projectId && (await bindDiscordChannel(conversation, projectId, interaction.user.id));
    await ephemeralFollowUp(
      interaction.token,
      done
        ? `This ${conversation.direct ? 'conversation' : 'channel'} now uses the Kortix project ${project.name}. ${conversation.direct ? 'Send' : 'Mention the bot with'} your message to start.`
        : 'Kortix could not connect this channel. Use /connect again.',
    );
    return;
  }
  if (isCommandPressData(data)) {
    await runCommandPress(
      commandContext(ctx),
      data,
      async (reply) => {
        await editMessage(conversation.threadId, ref, discordCommandMessage(reply)).catch((error) =>
          logger.warn('[discord] command reply not drawn', { error: String(error) }),
        );
      },
      async (text) => void (text ? await ephemeralFollowUp(interaction.token, text) : undefined),
    );
    return;
  }
  await handleQuestionTap(
    discordPort,
    { target: { ...target, messageId: ref }, ref, data, id: interaction.token },
    answerFollowUp(event, conversation, interaction.user),
    run,
  );
}

/** A select menu's pick is its chosen value; a button's, its `custom_id`. */
export function interactionPressData(componentId: string, values: unknown): string {
  return componentId === COMMAND_SELECT_ID && Array.isArray(values) && typeof values[0] === 'string' ? values[0] : componentId;
}

export function isDiscordInteractionEvent(event: IntegrationEvent): boolean {
  return event.type === DISCORD_INTERACTION_EVENT;
}

// One queue for every Discord event, and one order per conversation: a message
// and a press run in the order Discord stamped them (gateway.ts, inbound.ts `sequence`).
registerEventConsumer('discord.', (event, run) =>
  isDiscordInteractionEvent(event) ? handleDiscordInteraction(event, run) : handleDiscordMessage(event, run));
registerSessionPort('discord', discordPort);

export type { DiscordStoredInteraction };
