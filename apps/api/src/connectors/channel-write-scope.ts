/**
 * Channel connector writes, kept in the conversations they belong to: Slack
 * writes out of other projects' conversations, Telegram writes of a chat's
 * session in that chat.
 *
 * Every rule below reads the call's declared arguments. The gateway refuses a
 * channel call with any other argument before these gates run (`invalid_args`,
 * `undeclaredChannelArg` in channels.ts): `body`, for one, would replace the
 * whole request that was checked.
 *
 * SLACK. Every project in a Slack workspace posts with the same bot token
 * (channel-read-scope.ts explains why). Reads are confined there. This module
 * confines the writes: posts, files, edits, deletes, reactions, joins, and
 * thread binds. Without it an agent in one project could post into another
 * project's channel and collect the replies, reply into its threads, or edit
 * and delete its bot's messages.
 *
 * THE RULE. A project's agent never acts inside another project's channel or
 * thread:
 *   1. A thread that belongs to another project (`chat_threads`) is refused:
 *      no reply, no file, no edit, delete or reaction on its root message, no
 *      bind.
 *   2. A channel or group DM bound to another project (`chat_channel_bindings`)
 *      is refused for every write, unless the target thread is this project's
 *      own (the thread's owner wins, as for reads).
 *   3. A direct message is addressed to one person. Its binding decides only
 *      where that person's new messages go, so it does not block a write; rule 1
 *      still applies. A new DM message starts this project's own thread.
 *   4. Everything else is allowed: this project's conversations and
 *      conversations no project owns.
 *
 * Rule 1 knows a thread by its root `ts`. The own `ts` of a reply inside
 * another project's thread is not recognized in a DM or an unowned channel;
 * reads are confined, so such a `ts` cannot come from the connector.
 *
 * chat.postMessage also accepts a public channel's NAME, and Slack does not
 * document how it matches one. So a post is checked twice: its `channel`
 * before the call, and where Slack says it landed after the call. A post that
 * landed anywhere but the checked conversation (or, for a user id, that
 * person's DM) is taken back and refused.
 *
 * TEAMS. Teams writes do not go through the connector: every send resolves
 * through `resolveTeamsProjectConversation` (channels/teams/post.ts), which
 * already addresses only this project's own conversations.
 *
 * TELEGRAM. Each project has its own bot, so the risk is inside one project:
 * an agent in the session of chat A must not send to, edit or delete in chat
 * B, another person's private chat or another group of the same bot.
 *   1. A session a Telegram chat started (`metadata.source` and
 *      `metadata.telegram.chat_id`, both server-managed keys) or a Telegram
 *      chat is bound to (`chat_threads`, for example a reminder's successor)
 *      writes only into that chat: `chat_id` must be its numeric id. Any forum
 *      topic of the chat is fine. Another chat, a `@channel` name and a
 *      malformed id are refused before the call.
 *   2. Rule 1 follows the lineage: a session that such a session started
 *      (`spawned_by_session`), or a reminder successor that replaces it
 *      (`reminder_successor_of`), writes only into the chats of every session
 *      up its lineage (`sessionTelegramChats`).
 *   3. Any other session (web, triggers, automations) and a call without a
 *      session write to any chat of the bot: an automation that sends order
 *      notifications relies on it.
 *   4. Reads (`TELEGRAM_READS`) are not confined.
 * Kortix's own replies (notices, questions, menus) do not go through the
 * connector and are not checked here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { chatThreads, projectSessions } from '@kortix/db';
import { isRecord } from '@kortix/shared/guards';
import { db } from '../shared/db';
import {
  CHANNEL_READ_SCOPES,
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelOwnership,
  type ChannelReadInput,
  type ChannelReadRefusal,
  SLACK_TS,
  dbChannelOwnership,
  noInstall,
} from './channel-read-scope';

/**
 * Where each Slack write names its conversation and its message or thread.
 * A unit test fails when a Slack catalog write has no entry, and a write
 * without one is refused at call time.
 */
export const SLACK_WRITE_TARGETS: Record<string, { channel: string; ts?: string; tsRequired?: boolean }> = {
  send_message: { channel: 'channel', ts: 'thread_ts' },
  update_message: { channel: 'channel', ts: 'ts', tsRequired: true },
  delete_message: { channel: 'channel', ts: 'ts', tsRequired: true },
  add_reaction: { channel: 'channel', ts: 'timestamp', tsRequired: true },
  remove_reaction: { channel: 'channel', ts: 'timestamp', tsRequired: true },
  join_channel: { channel: 'channel' },
};

/**
 * A conversation or user id in Slack's own shape: a type letter, then
 * uppercase letters and digits. A lowercase name or `#name` is refused before
 * the call; an uppercase name slips through only to be caught where it lands.
 */
const SLACK_WRITE_ID = /^[CDGUW][A-Z0-9]{1,20}$/;

/** A DM channel (`D…`) or a user id (`U…`, `W…`), which chat.postMessage turns into the DM. */
function isDirectMessage(id: string): boolean {
  return id.startsWith('D') || id.startsWith('U') || id.startsWith('W');
}

/**
 * Why a write is refused: a malformed id, no install on record, another
 * project's thread, or another project's channel. Callers map the kind to
 * their own status; the connector refuses every kind alike.
 */
export interface SlackWriteRefusal {
  kind: 'invalid' | 'install' | 'thread' | 'channel';
  message: string;
}

/**
 * Why this project may not write to `channel` (and to the thread or message
 * `ts` in it), or null when it may. The one check behind the connector, the
 * file upload route, and the bind-thread route.
 */
export async function slackWriteRefusal(
  projectId: string,
  target: { channel: unknown; ts?: unknown; tsArg?: string; tsRequired?: boolean },
  ownership: ChannelOwnership = dbChannelOwnership,
): Promise<SlackWriteRefusal | null> {
  const channel = typeof target.channel === 'string' && SLACK_WRITE_ID.test(target.channel) ? target.channel : null;
  if (!channel) {
    return {
      kind: 'invalid',
      message:
        '`channel` must be one Slack conversation or user id as Slack issues it, for example C0123ABCD or U0123ABCD. A channel name is not accepted: find the id with list_channels.',
    };
  }
  const tsArg = target.tsArg ?? 'ts';
  const given = target.ts !== undefined && target.ts !== null && target.ts !== '';
  if (!given && target.tsRequired) return { kind: 'invalid', message: `\`${tsArg}\` is required.` };
  const ts = given ? (typeof target.ts === 'string' && SLACK_TS.test(target.ts) ? target.ts : null) : undefined;
  if (ts === null) {
    return { kind: 'invalid', message: `\`${tsArg}\` must be one Slack message timestamp, for example 1700000000.000100.` };
  }

  const { workspaceIds } = await ownership.installs(projectId, 'slack');
  if (workspaceIds.length === 0) return { kind: 'install', message: noInstall('slack') };

  if (ts) {
    const owner = (await ownership.threadOwners('slack', workspaceIds, [ts])).get(ts);
    if (owner === projectId) return null;
    if (owner) {
      return {
        kind: 'thread',
        message: `Slack thread ${ts} in ${channel} belongs to another Kortix project. This project's agent does not post in, change, or react to another project's threads.`,
      };
    }
  }
  if (isDirectMessage(channel)) return null;
  const owners = (await ownership.channelProjects('slack', workspaceIds, [channel])).get(channel);
  if (!owners?.size || owners.has(projectId)) return null;
  return {
    kind: 'channel',
    message: `Slack conversation ${channel} belongs to another Kortix project. This project's agent does not post in, change, or react to messages in another project's channels. Post in a channel of this project, in a channel no project is connected to, or in a direct message.`,
  };
}

/** A write that ran but landed somewhere it was not checked: the refusal, and the call that takes it back. */
export interface ChannelWriteMisfire {
  refusal: ChannelReadRefusal;
  /** The Slack method and args that remove the message; null when the answer does not name it. */
  undo: { path: string; args: Record<string, unknown> } | null;
}

/** The connector's write check: refused before the call, or checked on its answer. */
export interface ChannelWriteGate {
  refusal: ChannelReadRefusal | null;
  /** On a successful answer: null when the write landed where it was checked. */
  misfire(data: unknown): ChannelWriteMisfire | null;
}

const PASS: ChannelWriteGate = { refusal: null, misfire: () => null };

function refuse(message: string): ChannelWriteGate {
  return { refusal: { reason: CONVERSATION_NOT_IN_PROJECT, message }, misfire: () => null };
}

/**
 * The Telegram catalog actions that do not write into a chat. Every other
 * Telegram action is a write into the chat its `chat_id` names; a unit test
 * pins the list against the catalog.
 */
export const TELEGRAM_READS: ReadonlySet<string> = new Set(['get_chat', 'get_me']);

/** How many sessions up the lineage `sessionTelegramChats` reads. */
const LINEAGE_HOPS = 8;

/**
 * The chats a session answers, as numeric chat ids: every chat that started or
 * is bound to the session or a session before it. The lineage runs up
 * `spawned_by_session` (a session another session started) and
 * `reminder_successor_of` (the session a failed reminder's successor
 * replaces), both server-managed keys. Null when no Telegram chat started and
 * none is bound to any of them: that session writes to any chat.
 *
 * A session cannot shed its chat by starting another one: a lineage that is
 * longer than LINEAGE_HOPS, or that names a session that is not on record,
 * answers only the chats found so far (none: it writes to no chat).
 */
export async function sessionTelegramChats(projectId: string, sessionId: string | null): Promise<string[] | null> {
  if (!sessionId) return null;
  const chats = new Set<string>();
  const seen = new Set<string>();
  let confined = false;
  let frontier = [sessionId];
  for (let hop = 0; frontier.length > 0; hop++) {
    if (hop > LINEAGE_HOPS) {
      confined = true;
      break;
    }
    for (const id of frontier) seen.add(id);
    const [sessions, threads] = await Promise.all([
      db
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(and(inArray(projectSessions.sessionId, frontier), eq(projectSessions.projectId, projectId))),
      db
        .select({ threadId: chatThreads.threadId })
        .from(chatThreads)
        .where(
          and(eq(chatThreads.projectId, projectId), inArray(chatThreads.sessionId, frontier), eq(chatThreads.platform, 'telegram')),
        ),
    ]);
    // A thread is the chat id, or `<chat id>:<topic id>` for a forum topic.
    for (const row of threads) chats.add(row.threadId.split(':')[0]!);
    if (hop > 0 && sessions.length < frontier.length) confined = true;
    const parents = new Set<string>();
    for (const row of sessions) {
      const metadata = isRecord(row.metadata) ? row.metadata : {};
      if (metadata.source === 'telegram') {
        confined = true;
        const chat = isRecord(metadata.telegram) ? telegramChatId(metadata.telegram.chat_id) : null;
        if (chat) chats.add(chat);
      }
      for (const parent of [metadata.spawned_by_session, metadata.reminder_successor_of]) {
        if (typeof parent === 'string' && parent && !seen.has(parent)) parents.add(parent);
      }
    }
    frontier = [...parents];
  }
  return confined || chats.size ? [...chats] : null;
}

/** A chat id as Telegram issues it, normalized to its decimal string; null for anything else. */
function telegramChatId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' && /^-?[1-9]\d{0,19}$/.test(value) ? value : null;
}

/**
 * Why a session that answers the chats `own` may not write into `chatId`, or
 * null when it may. `own` null: the session answers no Telegram chat.
 */
export function telegramWriteRefusal(chatId: unknown, own: string[] | null): string | null {
  if (!own) return null;
  const id = telegramChatId(chatId);
  if (id && own.includes(id)) return null;
  const answers = own.length
    ? `This session answers Telegram chat ${own.join(' or ')} only.`
    : "This session's Telegram chat is not on record, so it writes to no chat.";
  return `${answers} It does not send to, edit or delete messages in other chats.`;
}

/** Reads are gated in channel-read-scope.ts; this gates the writes. */
export async function gateChannelWrite(
  input: Omit<ChannelReadInput, 'risk'>,
  ownership: ChannelOwnership = dbChannelOwnership,
): Promise<ChannelWriteGate> {
  if (input.platform === 'telegram') {
    if (TELEGRAM_READS.has(input.actionPath)) return PASS;
    const refusal = telegramWriteRefusal(input.args.chat_id, await sessionTelegramChats(input.projectId, input.sessionId ?? null));
    return refusal ? refuse(refusal) : PASS;
  }
  if (input.platform !== 'slack' && input.platform !== 'teams') return PASS;
  const scopes = CHANNEL_READ_SCOPES[input.platform];
  if (!Object.hasOwn(scopes, input.actionPath) || scopes[input.actionPath] !== 'write') return PASS;
  const target = input.platform === 'slack' && Object.hasOwn(SLACK_WRITE_TARGETS, input.actionPath)
    ? SLACK_WRITE_TARGETS[input.actionPath]
    : null;
  if (!target) {
    return refuse(
      `The ${input.platform === 'slack' ? 'Slack' : 'Microsoft Teams'} connector does not run write action "${input.actionPath}": it has no rule that keeps it out of other projects' conversations.`,
    );
  }
  const channel = input.args[target.channel];
  const refusal = await slackWriteRefusal(
    input.projectId,
    { channel, ts: target.ts ? input.args[target.ts] : undefined, tsArg: target.ts, tsRequired: target.tsRequired },
    ownership,
  );
  if (refusal) return refuse(refusal.message);
  // Slack documents names only for chat.postMessage; every other write takes an id.
  if (input.actionPath !== 'send_message') return PASS;
  return { refusal: null, misfire: (data) => postMisfire(channel as string, data) };
}

/**
 * Where chat.postMessage says it posted (`channel`, `ts` of the answer) must
 * be the conversation that was checked; for a user id, a DM.
 */
function postMisfire(checked: string, data: unknown): ChannelWriteMisfire | null {
  const answer = data != null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const landed = typeof answer.channel === 'string' ? answer.channel : null;
  const toPerson = checked.startsWith('U') || checked.startsWith('W');
  if (landed === checked || (toPerson && landed?.startsWith('D'))) return null;
  return {
    refusal: {
      reason: CONVERSATION_NOT_IN_PROJECT,
      message: `Slack posted the message to ${landed ?? 'a conversation it did not name'}, not to ${checked}, the conversation that was checked. Address a conversation by its id.`,
    },
    undo: landed && typeof answer.ts === 'string' ? { path: '/chat.delete', args: { channel: landed, ts: answer.ts } } : null,
  };
}
