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
 *   1. A thread or DM a session of this project holds (`chat_threads`), or a
 *      channel or DM bound to this project (`chat_channel_bindings`): allowed.
 *   2. One another project holds or is bound to: refused.
 *   3. Any other channel: Discord says where it is (`GET /channels/{id}`). A
 *      channel or thread in this project's server whose channel (a thread's
 *      parent) no other project is bound to is allowed. Another server, and a
 *      DM no conversation of this project runs in, are refused.
 *   4. A session a Discord conversation started (or a session in its lineage,
 *      as for Telegram) acts only in its own conversations
 *      (`sessionChannelChats`).
 *   5. A reply quotes a message of the same channel: `message_reference` names
 *      no other channel and never forwards (a forward copies another channel's
 *      message here).
 *
 * Discord unreachable: refused, never allowed. Kortix's own replies (notices,
 * questions, menus) do not go through the connector.
 */
import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, chatThreads } from '@kortix/db';
import { isRecord } from '@kortix/shared/guards';
import { db } from '../shared/db';
import { type DiscordChannel, discordCall, isDiscordThread } from '../channels/discord/api';
import { discordChannelId, sessionChannelChats } from './channel-write-scope';

/** Who holds a channel: the projects of its sessions' threads and of its bindings. */
async function holders(channelId: string): Promise<Set<string>> {
  const [threads, bindings] = await Promise.all([
    db.select({ projectId: chatThreads.projectId }).from(chatThreads).where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.threadId, channelId))),
    db
      .select({ projectId: chatChannelBindings.projectId })
      .from(chatChannelBindings)
      .where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, channelId))),
  ]);
  return new Set([...threads, ...bindings].flatMap((r) => (r.projectId ? [r.projectId] : [])));
}

async function projectGuild(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ guildId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.projectId, projectId)))
    .limit(1);
  return row?.guildId ?? null;
}

const notThisProject = (channelId: string) =>
  `Discord channel ${channelId} is not a conversation of this Kortix project. This project's agent reads and writes only in its own server's channels and threads, and in direct messages its conversations run in.`;

/**
 * Why this project (and, from a session, this session) may not act in the
 * channel a call names, or null when it may.
 */
export async function discordCallRefusal(input: { projectId: string; sessionId?: string | null; args: Record<string, unknown> }): Promise<string | null> {
  const channelId = discordChannelId(input.args.channel_id);
  if (!channelId) return '`channel_id` must be one Discord channel id (a snowflake, 17 to 20 digits).';
  const reference = input.args.message_reference;
  if (reference !== undefined) {
    if (!isRecord(reference)) return '`message_reference` must be an object, for example {"message_id": "<id>"}.';
    if (reference.type !== undefined && reference.type !== 0) return '`message_reference` only replies; it does not forward messages.';
    if (reference.channel_id !== undefined && reference.channel_id !== channelId) {
      return '`message_reference` must quote a message of the same channel.';
    }
  }

  const own = await sessionChannelChats('discord', input.projectId, input.sessionId ?? null);
  if (own && !own.includes(channelId)) {
    return own.length
      ? `This session answers Discord conversation ${own.join(' or ')} only. It does not read or write in other channels.`
      : "This session's Discord conversation is not on record, so it reads and writes in no channel.";
  }

  const held = await holders(channelId);
  if (held.has(input.projectId)) return null;
  if (held.size) return notThisProject(channelId);

  const guildId = await projectGuild(input.projectId);
  if (!guildId) return 'This Kortix project has no Discord server connected.';
  let channel: DiscordChannel;
  try {
    channel = await discordCall<DiscordChannel>('GET /channels/{id}', `/channels/${channelId}`, { timeoutMs: 5_000 });
  } catch {
    return `Kortix could not check Discord channel ${channelId} just now, so the call did not run. Try again in a minute.`;
  }
  if (channel.guild_id !== guildId) return notThisProject(channelId);
  if (isDiscordThread(channel.type) && channel.parent_id) {
    const parent = await holders(channel.parent_id);
    if (parent.size && !parent.has(input.projectId)) return notThisProject(channelId);
  }
  return null;
}
