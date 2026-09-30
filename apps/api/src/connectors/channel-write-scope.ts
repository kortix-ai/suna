/**
 * Slack writes, kept out of other projects' conversations.
 *
 * Every project in a Slack workspace posts with the same bot token
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
 * Teams writes do not go through the connector: every send resolves through
 * `resolveTeamsProjectConversation` (channels/teams/post.ts), which already
 * addresses only this project's own conversations.
 */
import {
  CHANNEL_READ_SCOPES,
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelOwnership,
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

/** Reads are gated in channel-read-scope.ts; this gates the writes. */
export async function gateChannelWrite(
  input: { projectId: string; platform: string | null; actionPath: string; args: Record<string, unknown> },
  ownership: ChannelOwnership = dbChannelOwnership,
): Promise<ChannelWriteGate> {
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
