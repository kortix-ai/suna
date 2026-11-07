/**
 * Discord connector calls, kept in the calling project's own conversations.
 *
 * Every Kortix project talks to Discord through ONE bot token, the Kortix
 * Discord application's, and that bot sits in every server any project
 * installed it in. The token alone would let an agent in one project read and
 * post in another customer's server. So every `kortix_discord` action, read or
 * write, names one channel (`channel_id`), and the gateway runs it only when
 * that channel is this project's:
 *
 *   1. Who holds a channel: its binding (`chat_channel_bindings`) when it has
 *      one, else the threads its sessions hold (`chat_threads`). Either counts
 *      only while that project still has the server installed: a project that
 *      left a server, or a DM moved to another project, holds nothing there.
 *   2. Held by this project: allowed. Held by another: refused.
 *   3. Held by none: Discord says where it is (`GET /channels/{id}`). A channel
 *      or thread of this project's server whose channel (a thread's parent)
 *      no other project holds is allowed, but only while no other project has
 *      the server installed (Slack's read rule): in a shared server each
 *      project acts in its own conversations and bound channels only.
 *   4. A session a Discord conversation started (or a session in its lineage,
 *      as for Telegram) acts only in its own conversations
 *      (`sessionChannelChats`).
 *   5. A direct message's history is read from the time the DM came to this
 *      project (`after` only): a DM moved from another project keeps that
 *      project's replies.
 *   6. A reply quotes a message of the same channel: `message_reference` names
 *      no other channel and never forwards. `message_id` is a snowflake and
 *      `emoji` names one emoji, so no path argument leaves the channel's route.
 *   7. One project makes at most 60 calls a minute per replica: the bot's
 *      request budget, and Discord's invalid-request ban, are shared by every
 *      project. A channel Discord refused is not asked again for 10 minutes.
 *
 * Discord unreachable: refused, never allowed. Kortix's own replies (notices,
 * questions, menus) do not go through the connector.
 */
import { and, desc, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, chatThreads } from '@kortix/db';
import { isRecord } from '@kortix/shared/guards';
import { db } from '../shared/db';
import { type DiscordChannel, discordCall, isDiscordThread } from '../channels/discord/api';
import { discordGuildProjects } from '../channels/discord/installs';
import { discordChannelId, sessionChannelChats } from './channel-write-scope';
import { projectsView } from '../workspaces/rows';

const CALLS_PER_MINUTE = 60;
const REFUSED_CHANNEL_TTL_MS = 10 * 60_000;
// replica-local: each project's calls in the current minute, on this replica.
const callWindows = new Map<string, { start: number; count: number }>();
// replica-local: channels Discord refused or placed in another server, not asked again until the time.
const refusedChannels = new Map<string, number>();

/** False when the project spent its calls for this minute. */
function takeCall(projectId: string, now = Date.now()): boolean {
  const window = callWindows.get(projectId);
  if (!window || now - window.start >= 60_000) {
    if (callWindows.size > 10_000) callWindows.clear();
    callWindows.set(projectId, { start: now, count: 1 });
    return true;
  }
  window.count += 1;
  return window.count <= CALLS_PER_MINUTE;
}

/** The milliseconds of a time as the lowest snowflake Discord could stamp then. */
const snowflakeAt = (ms: number) => ((BigInt(Math.max(ms, 1_420_070_400_000)) - 1_420_070_400_000n) << 22n).toString();

interface Holding {
  projects: Set<string>;
  /** This project's binding of a DM: reads start at it. */
  dmSince: Date | null;
}

/**
 * Who holds a channel, among projects that still have the holding row's
 * server installed: its bindings when it has any, else its sessions' threads.
 */
async function holding(channelId: string, projectId: string): Promise<Holding> {
  const installed = (table: typeof chatThreads | typeof chatChannelBindings) =>
    and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.platformTeamId, table.platformTeamId), eq(chatInstalls.projectId, table.projectId));
  const bindings = await db
    .select({ projectId: chatChannelBindings.projectId, type: chatChannelBindings.channelType, since: chatChannelBindings.installedAt })
    .from(chatChannelBindings)
    .innerJoin(chatInstalls, installed(chatChannelBindings))
    .innerJoin(projectsView, and(eq(projectsView.projectId, chatChannelBindings.projectId), eq(projectsView.status, 'active')))
    .where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, channelId)))
    .orderBy(desc(chatChannelBindings.installedAt));
  if (bindings.length) {
    const mine = bindings.find((b) => b.projectId === projectId);
    return {
      projects: new Set(bindings.flatMap((b) => (b.projectId ? [b.projectId] : []))),
      dmSince: mine?.type === 'dm' ? mine.since : null,
    };
  }
  const threads = await db
    .select({ projectId: chatThreads.projectId })
    .from(chatThreads)
    .innerJoin(chatInstalls, installed(chatThreads))
    .innerJoin(projectsView, and(eq(projectsView.projectId, chatThreads.projectId), eq(projectsView.status, 'active')))
    .where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.threadId, channelId)));
  return { projects: new Set(threads.map((t) => t.projectId)), dmSince: null };
}

async function projectGuild(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ guildId: chatInstalls.platformTeamId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.projectId, projectId)))
    .limit(1);
  return row?.guildId ?? null;
}

const notThisProject = (channelId: string) =>
  `Discord channel ${channelId} is not a conversation of this Kortix workspace. This workspace's agent reads and writes only in its own server's channels and threads, and in direct messages its conversations run in.`;

const SNOWFLAKE = /^\d{17,20}$/;

/** Why a call's other arguments leave its channel, or null. */
function argumentRefusal(args: Record<string, unknown>, channelId: string): string | null {
  if (args.message_id !== undefined && (typeof args.message_id !== 'string' || !SNOWFLAKE.test(args.message_id))) {
    return '`message_id` must be one Discord message id (a snowflake, 17 to 20 digits).';
  }
  if (args.emoji !== undefined && (typeof args.emoji !== 'string' || !args.emoji || args.emoji.length > 64 || /[/\\?#%]/.test(args.emoji) || /^\.+$/.test(args.emoji))) {
    return '`emoji` must be one Unicode emoji, or `name:id` for a custom one.';
  }
  const reference = args.message_reference;
  if (reference !== undefined) {
    if (!isRecord(reference)) return '`message_reference` must be an object, for example {"message_id": "<id>"}.';
    if (reference.type !== undefined && reference.type !== 0) return '`message_reference` only replies; it does not forward messages.';
    if (reference.channel_id !== undefined && reference.channel_id !== channelId) {
      return '`message_reference` must quote a message of the same channel.';
    }
  }
  return null;
}

/**
 * Why this project (and, from a session, this session) may not run the call,
 * or null when it may.
 */
export async function discordCallRefusal(input: {
  projectId: string;
  sessionId?: string | null;
  actionPath?: string;
  args: Record<string, unknown>;
}): Promise<string | null> {
  const channelId = discordChannelId(input.args.channel_id);
  if (!channelId) return '`channel_id` must be one Discord channel id (a snowflake, 17 to 20 digits).';
  const bad = argumentRefusal(input.args, channelId);
  if (bad) return bad;
  if (!takeCall(input.projectId)) {
    return `This project made more than ${CALLS_PER_MINUTE} Discord calls in the last minute. Wait a minute, then try again.`;
  }

  const own = await sessionChannelChats('discord', input.projectId, input.sessionId ?? null);
  if (own && !own.includes(channelId)) {
    return own.length
      ? `This session answers Discord conversation ${own.join(' or ')} only. It does not read or write in other channels.`
      : "This session's Discord conversation is not on record, so it reads and writes in no channel.";
  }

  const held = await holding(channelId, input.projectId);
  if (held.projects.has(input.projectId)) {
    if (held.dmSince && input.actionPath === 'get_messages') {
      const since = snowflakeAt(held.dmSince.getTime());
      const after = typeof input.args.after === 'string' && SNOWFLAKE.test(input.args.after) ? input.args.after : null;
      // `before` and `around` reach back past the move; Discord takes one of the three, so `after` alone.
      if (!after || BigInt(after) < BigInt(since) || input.args.before !== undefined || input.args.around !== undefined) {
        return `In this direct message, read with \`after\` set to ${since} or later, and no \`before\` or \`around\`: earlier messages belong to the conversation before it came to this project.`;
      }
    }
    return null;
  }
  if (held.projects.size) return notThisProject(channelId);

  const refusedUntil = refusedChannels.get(channelId);
  if (refusedUntil && refusedUntil > Date.now()) return notThisProject(channelId);
  const guildId = await projectGuild(input.projectId);
  if (!guildId) return 'This Kortix workspace has no Discord server connected.';
  let channel: DiscordChannel;
  try {
    channel = await discordCall<DiscordChannel>('GET /channels/{id}', `/channels/${channelId}`, { timeoutMs: 5_000 });
  } catch (error) {
    // A refusal (unknown channel, no access) is remembered; an outage is not.
    const status = (error as { status?: number }).status ?? 0;
    if (status >= 400 && status < 500 && status !== 429) {
      if (refusedChannels.size > 10_000) refusedChannels.clear();
      refusedChannels.set(channelId, Date.now() + REFUSED_CHANNEL_TTL_MS);
    }
    return `Kortix could not check Discord channel ${channelId}, so the call did not run.`;
  }
  if (channel.guild_id !== guildId) {
    if (refusedChannels.size > 10_000) refusedChannels.clear();
    refusedChannels.set(channelId, Date.now() + REFUSED_CHANNEL_TTL_MS);
    return notThisProject(channelId);
  }
  if (isDiscordThread(channel.type) && channel.parent_id) {
    const parent = await holding(channel.parent_id, input.projectId);
    if (parent.projects.size && !parent.projects.has(input.projectId)) return notThisProject(channelId);
    if (parent.projects.has(input.projectId)) return null;
  }
  if ((await discordGuildProjects(guildId)).length > 1) {
    return `Discord channel ${channelId} belongs to no conversation of this Kortix workspace, and its server is connected to more than one Kortix workspace: this workspace's agent acts only in its own conversations and bound channels there.`;
  }
  return null;
}

/** For tests: forget the replica-local windows and refusals. */
export function resetDiscordScopeForTest(): void {
  callWindows.clear();
  refusedChannels.clear();
}
