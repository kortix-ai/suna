/**
 * The Discord Gateway: the one WebSocket that delivers the messages written to
 * the Kortix Discord application's bot. Discord sends messages only over it
 * (interactions come to the webhook, inbound.ts), so exactly one process holds
 * it: the leader (worker/jobs/discord-gateway.ts).
 *
 * The connection: HELLO → IDENTIFY (or RESUME) → heartbeats at Discord's
 * interval. A heartbeat Discord did not acknowledge, a RECONNECT or a dropped
 * socket resumes the session from the last sequence, so Discord replays what
 * was missed; an invalid session identifies again. A close Discord calls fatal
 * (a bad token) stops it, logged. Intents the application lacks (4014) drop
 * the Message Content intent and identify again: mentions and DMs keep working.
 * An identify first asks Discord how many of the day's 1,000 are left.
 *
 * The intake (`intakeMessage`) stores in the event inbox only what is written
 * to the bot: a DM, a mention, an edit that adds a mention, and, with the
 * Message Content intent (`DISCORD_MESSAGE_CONTENT`), any message in a thread
 * a Kortix session holds. It routes each to its project (routing.ts) first; a
 * server with no project, or more than one, hears once per channel and hour
 * what to do instead. One channel's messages are taken one at a time, in
 * Discord's order; a failed intake is tried again 3 times, then the sender
 * hears to send it again. A stop waits for the intakes in flight and saves the
 * sequence before the first unfinished one, so the next leader's resume
 * replays it.
 */
import { chatInstalls, platformSettings } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { readChannelAccess } from '../core/channel-access';
import { CHANNEL_COMMANDS } from '../core/command-list';
import { claimThreadCreate, findChatThread, releaseThreadCreate } from '../core/threads';
import { config } from '../../config';
import { emitIntegrationEvent } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { type DiscordChannel, discordCall, discordConfigured, discordPost, discordUnreachable, isDiscordThread, snowflakeSequence } from './api';
import { forgetDiscordChannel, forgetDiscordGuild, leaveDiscordGuild } from './installs';
import { resolveDiscordRoute } from './routing';
import {
  DISCORD_MESSAGE_EVENT,
  type DiscordAttachment,
  type DiscordConversation,
  type DiscordMessageEventData,
  type DiscordStoredMessage,
} from './types';
import { projectsView } from '../../workspaces/rows';

/**
 * GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES. Discord sends a message's text
 * without a privileged intent for a DM and a mention of the app. MESSAGE_CONTENT
 * (privileged) adds the text of every other message: identifying with it when
 * the application lacks it is a fatal close (4014).
 */
export function discordIntents(messageContent = config.DISCORD_MESSAGE_CONTENT): number {
  return (1 << 0) | (1 << 9) | (1 << 12) | (messageContent ? 1 << 15 : 0);
}

/** Closes after which a reconnect cannot help: authentication, sharding, API version, intents. */
const FATAL_CLOSES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Intents the application may not use: the Message Content intent Discord has not granted. */
const DISALLOWED_INTENTS = 4014;
/** Closes after which the session cannot resume: an invalid sequence, a session that timed out. */
const NEW_SESSION_CLOSES = new Set([4007, 4009]);
/** Our own close to resume: any code but 1000 and 1001 keeps the session resumable. */
const RESUME_CLOSE = 4000;
/** A channel a REST call described, this long; one the Gateway reported stays current by its events. */
const CHANNEL_TTL_MS = 30 * 60_000;
/** The most channels the leader keeps; past it, the oldest go. */
const MAX_CHANNELS = 100_000;
/** An edit is read while its message is this young: it may add the mention the message lacked. */
const EDIT_WINDOW_MS = 15 * 60_000;
/** Discord caps an unverified application at 100 servers; past this many, the operator hears it. */
const VERIFY_BEFORE_GUILDS = 75;
/** One "use /connect" or "not connected" notice per channel, this often. */
const NOTICE_EVERY_MS = 60 * 60_000;

interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

/** The fields of a Gateway message the intake reads. */
export interface GatewayMessage {
  id: string;
  type?: number;
  channel_id: string;
  guild_id?: string;
  author?: { id: string; username?: string; global_name?: string | null; bot?: boolean };
  member?: { nick?: string | null };
  webhook_id?: string;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  flags?: number;
  attachments?: DiscordAttachment[];
  mentions?: Array<{ id: string; username?: string; global_name?: string | null }>;
  mention_roles?: string[];
  sticker_items?: Array<{ name: string }>;
  /** The message a reply answers. */
  referenced_message?: { author?: { id?: string } } | null;
  /** A forward: the forwarded message's text and files. */
  message_snapshots?: Array<{ message?: { content?: string; attachments?: DiscordAttachment[] } }>;
  poll?: { question?: { text?: string }; answers?: Array<{ poll_media?: { text?: string } }> };
}

/** `live`: the Gateway reported it, and its events keep it current. Else a REST answer, read again after `CHANNEL_TTL_MS`. */
type CachedChannel = Pick<DiscordChannel, 'id' | 'type' | 'name' | 'parent_id' | 'guild_id'> & { at: number; live: boolean };

// replica-local: the bot's own managed role in each guild (GUILD_CREATE), so a mention of the role counts as one of the app.
const botRoles = new Map<string, string>();

// replica-local: the leader's view of the channels its Gateway reported, refilled from REST on a miss.
const channels = new Map<string, CachedChannel>();

// replica-local: guilds whose channels one REST call filled, after a resume that sent no GUILD_CREATE.
const filledGuilds = new Set<string>();

/** The bot's managed role in a guild (GUILD_CREATE). */
export function rememberBotRole(guildId: string, roleId: string): void {
  botRoles.set(guildId, roleId);
}

/** For tests: forget every cached channel, guild fill and bot role. */
export function resetDiscordGatewayCacheForTest(): void {
  channels.clear();
  filledGuilds.clear();
  botRoles.clear();
}

function cacheChannel(channel: Partial<DiscordChannel> & { id?: string }, live: boolean, guildId?: string): void {
  if (!channel.id || typeof channel.type !== 'number') return;
  if (channels.size >= MAX_CHANNELS && !channels.has(channel.id)) {
    // The oldest tenth goes: Map keeps insertion order. A miss reads it again.
    let drop = Math.ceil(MAX_CHANNELS / 10);
    for (const id of channels.keys()) {
      if (drop-- <= 0) break;
      channels.delete(id);
    }
  }
  channels.set(channel.id, {
    id: channel.id,
    type: channel.type,
    name: channel.name ?? null,
    parent_id: channel.parent_id ?? null,
    guild_id: channel.guild_id ?? guildId,
    at: Date.now(),
    live,
  });
}

/** A guild the bot left: its channels and role go from the caches. */
function forgetGuildCache(guildId: string): void {
  for (const [id, channel] of channels) if (channel.guild_id === guildId) channels.delete(id);
  filledGuilds.delete(guildId);
  botRoles.delete(guildId);
}

/**
 * A channel's type, name and parent: the Gateway's report, else Discord's.
 * A leader that resumed got no GUILD_CREATE: its first miss in a guild reads
 * the guild's channels in one call (`GET /guilds/{id}/channels`), not one per
 * channel. Null: Discord does not show the channel to the bot. Throws when
 * Discord could not answer and nothing is cached, so the intake tries again.
 */
export async function discordChannelInfo(channelId: string, guildId?: string): Promise<CachedChannel | null> {
  const cached = channels.get(channelId);
  if (cached && (cached.live || Date.now() - cached.at < CHANNEL_TTL_MS)) return cached;
  if (!cached && guildId && !filledGuilds.has(guildId)) {
    filledGuilds.add(guildId);
    try {
      const all = await discordCall<DiscordChannel[]>('GET /guilds/{id}/channels', `/guilds/${guildId}/channels`, { timeoutMs: 5_000 });
      for (const channel of Array.isArray(all) ? all : []) cacheChannel(channel, true, guildId);
      const hit = channels.get(channelId);
      if (hit) return hit;
    } catch (error) {
      filledGuilds.delete(guildId);
      logger.warn('[discord] server channels not readable', { error: String(error) });
    }
  }
  try {
    const channel = await discordCall<DiscordChannel>('GET /channels/{id}', `/channels/${channelId}`, { timeoutMs: 5_000 });
    cacheChannel(channel, false);
    return channels.get(channelId) ?? null;
  } catch (error) {
    // Discord did not answer: the last known channel still routes the message, else the intake tries again.
    if (discordUnreachable(error)) {
      if (cached) return cached;
      throw error;
    }
    logger.warn('[discord] channel not readable', { error: String(error) });
    return null;
  }
}

/** Post a notice in a channel at most once an hour. Never throws. A notice Discord refused frees the hour. */
async function noticeOnce(channelId: string, replyTo: string, content: string): Promise<void> {
  const key = `discord:notice:${channelId}`;
  let claim: Date | null = null;
  try {
    claim = await claimThreadCreate(key, NOTICE_EVERY_MS);
    if (!claim) return;
    await discordPost(channelId, { content, allowed_mentions: { parse: [] } }, replyTo);
  } catch (error) {
    logger.warn('[discord] notice not sent', { error: String(error) });
    if (claim) await releaseThreadCreate(key, claim).catch(() => undefined);
  }
}

/** A forward's message and a poll, as text the agent reads. */
function carriedText(m: GatewayMessage): string {
  const parts: string[] = [];
  const forwarded = m.message_snapshots?.[0]?.message;
  if (forwarded) parts.push(`(forwarded message)${forwarded.content ? `\n${forwarded.content}` : ''}`);
  const question = m.poll?.question?.text;
  if (question) {
    const answers = (m.poll?.answers ?? []).flatMap((a) => (a.poll_media?.text ? [a.poll_media.text] : []));
    parts.push(`(poll) ${question}${answers.length ? `\n${answers.map((a) => `- ${a}`).join('\n')}` : ''}`);
  }
  return parts.join('\n');
}

function storedMessage(m: GatewayMessage): DiscordStoredMessage {
  const carried = carriedText(m);
  const files = [...(m.attachments ?? []), ...(m.message_snapshots?.[0]?.message?.attachments ?? [])];
  return {
    id: m.id,
    channel_id: m.channel_id,
    ...(m.guild_id ? { guild_id: m.guild_id } : {}),
    author: {
      id: m.author!.id,
      ...(m.author!.username ? { username: m.author!.username } : {}),
      ...(m.author!.global_name ? { global_name: m.author!.global_name } : {}),
    },
    ...(m.member?.nick ? { nick: m.member.nick } : {}),
    content: m.content ?? '',
    ...(carried ? { carried } : {}),
    ...(m.flags ? { flags: m.flags } : {}),
    attachments: files.map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      url: a.url,
      ...(a.content_type ? { content_type: a.content_type } : {}),
      ...(a.duration_secs ? { duration_secs: a.duration_secs } : {}),
    })),
    mentions: (m.mentions ?? []).map((u) => ({ id: u.id, ...(u.username ? { username: u.username } : {}), ...(u.global_name ? { global_name: u.global_name } : {}) })),
    stickers: (m.sticker_items ?? []).map((s) => s.name),
  };
}

/** The project's Discord allow-list holds the user. */
async function projectAllows(projectId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ metadata: projectsView.metadata }).from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  return readChannelAccess(row?.metadata, 'discord').allowedUserIds.includes(userId);
}

/** Message types a person writes: a plain message and a reply. Joins, pins and boosts are not. */
const PERSON_MESSAGE_TYPES = new Set([0, 19]);

/**
 * One Gateway message: stored as an event of its project when it is written to
 * the bot, else nothing. `messageContent`: the connection holds the Message
 * Content intent (it may have dropped it, `DiscordGateway`). Throws when a
 * read or the store fails: the Gateway cannot redeliver it, so the caller
 * tries again.
 */
export async function intakeMessage(
  message: GatewayMessage,
  botUserId: string,
  opts: { messageContent?: boolean } = {},
): Promise<'stored' | 'ignored'> {
  const messageContent = opts.messageContent ?? config.DISCORD_MESSAGE_CONTENT;
  let m = message;
  if (!m.author?.id || m.author.bot || m.webhook_id || !PERSON_MESSAGE_TYPES.has(m.type ?? 0)) return 'ignored';
  const authorId = m.author.id;
  const guildId = m.guild_id ?? null;
  // People often pick the app's role ("@Kortix" with the role icon) instead of the app: it counts as a mention.
  const botRole = guildId ? botRoles.get(guildId) : undefined;
  let viaRole = false;
  if (botRole && (m.mention_roles ?? []).includes(botRole) && !(m.mentions ?? []).some((u) => u.id === botUserId)) {
    viaRole = true;
    m = {
      ...m,
      content: (m.content ?? '').replaceAll(`<@&${botRole}>`, `<@${botUserId}>`),
      mentions: [...(m.mentions ?? []), { id: botUserId }],
    };
  }
  let place: Omit<DiscordConversation, 'guildId'>;
  /** A reply to Kortix with its @mention turned off: Discord hides its text without the intent. */
  let unpingedReply = false;
  if (!guildId) {
    place = { threadId: m.channel_id, settingsId: m.channel_id, direct: true, startThread: false, addressed: true, channelName: null, threadName: null };
  } else {
    const mention = (m.mentions ?? []).some((u) => u.id === botUserId);
    unpingedReply = !mention && !messageContent && m.referenced_message?.author?.id === botUserId;
    // Without the intent a message that mentions no one carries no text: nothing to read, no lookup.
    if (!mention && !messageContent && !unpingedReply) return 'ignored';
    const channel = await discordChannelInfo(m.channel_id, guildId);
    if (!channel) return 'ignored';
    if (isDiscordThread(channel.type)) {
      // Without the Message Content intent a thread's other messages carry no text: only a mention counts.
      if (!mention && !unpingedReply && !(messageContent && (await findChatThread({ platform: 'discord', workspaceId: guildId, threadId: m.channel_id })))) {
        return 'ignored';
      }
      const parent = channel.parent_id ? channels.get(channel.parent_id) : undefined;
      place = {
        threadId: m.channel_id,
        settingsId: channel.parent_id ?? m.channel_id,
        direct: false,
        startThread: false,
        addressed: mention,
        channelName: parent?.name ?? null,
        threadName: channel.name ?? null,
      };
    } else {
      if (!mention && !unpingedReply) return 'ignored';
      // A text or announcement channel takes a thread on the message; another (a voice channel's chat) is the conversation itself.
      const threads = channel.type === 0 || channel.type === 5;
      place = {
        threadId: threads ? m.id : m.channel_id,
        settingsId: m.channel_id,
        direct: false,
        startThread: threads && mention,
        addressed: mention,
        channelName: channel.name ?? null,
        threadName: null,
      };
    }
  }

  const route = await resolveDiscordRoute({
    guildId,
    channelId: place.settingsId,
    ...(guildId && place.threadId === m.channel_id && place.threadId !== place.settingsId ? { threadId: m.channel_id } : {}),
    userId: authorId,
  });
  if (unpingedReply) {
    if (route.kind === 'project') {
      await noticeOnce(m.channel_id, m.id, 'Kortix did not read your reply: turn on @mention when you reply to Kortix, or mention @Kortix in your message. Without it, Discord does not show Kortix your message.');
    }
    return 'ignored';
  }
  if (route.kind !== 'project') {
    if (!place.addressed) return 'ignored';
    const text =
      route.kind === 'ambiguous'
        ? `More than one Kortix workspace can answer ${guildId ? 'in this channel' : 'you here'}. Use /connect to pick one.`
        : guildId
          ? 'This server is not connected to a Kortix workspace. A workspace admin connects it under Customize → Connectors → Channels → Discord.'
          : `Kortix does not know your Discord account yet. Ask a Kortix workspace admin to allow your Discord user id ${authorId} under Customize → Connectors → Channels → Discord.`;
    await noticeOnce(m.channel_id, m.id, text);
    return 'ignored';
  }
  // A thread's other messages (the Message Content intent) are stored only from someone the project allows.
  if (!place.addressed && !(await projectAllows(route.projectId, authorId))) return 'ignored';
  const data: DiscordMessageEventData = {
    message: { ...storedMessage(m), ...(viaRole ? { viaRole: true } : {}) },
    conversation: { ...place, guildId: route.guildId },
    botUserId,
    messageContent,
  };
  await emitIntegrationEvent({
    id: m.id,
    source: `discord:${guildId ?? 'dm'}`,
    type: DISCORD_MESSAGE_EVENT,
    time: m.timestamp ?? new Date().toISOString(),
    // One conversation's messages and presses run in the order Discord stamped them.
    subject: place.threadId,
    sequence: snowflakeSequence(m.id),
    projectId: route.projectId,
    data: data as unknown as Record<string, unknown>,
  });
  return 'stored';
}

/** An edit read as a message: one of a person's own message, while it is fresh. A message stored already is the same event, never stored twice. */
export function freshEdit(m: GatewayMessage, now = Date.now()): boolean {
  if (!m.edited_timestamp || !m.author?.id || !/^\d{17,20}$/.test(m.id ?? '')) return false;
  const created = Number(BigInt(m.id) >> 22n) + 1_420_070_400_000;
  return now - created < EDIT_WINDOW_MS;
}

/** Every try of the intake failed: a person who wrote to the bot hears to send it again. Never throws. */
async function tellNotTaken(m: GatewayMessage, botUserId: string): Promise<void> {
  if (!m.author?.id || m.author.bot || m.webhook_id) return;
  if (m.guild_id && !(m.mentions ?? []).some((u) => u.id === botUserId)) return;
  await discordPost(m.channel_id, { content: 'Kortix could not take this message. Send it again in a minute.', allowed_mentions: { parse: [] } }, m.id).catch(
    (error) => logger.warn('[discord] intake failure notice not sent', { error: String(error) }),
  );
}

/**
 * After a connect, the installs of guilds the bot is no longer in (it was
 * removed while no Gateway listened) go. Not when the list looks wrong: an
 * empty list, or one missing more than half the installed guilds, is logged.
 */
export async function reconcileGuilds(present: string[]): Promise<string[]> {
  try {
    const installed = [...new Set((await db.select({ guildId: chatInstalls.platformTeamId }).from(chatInstalls).where(eq(chatInstalls.platform, 'discord'))).map((r) => r.guildId))];
    const missing = installed.filter((id) => !present.includes(id));
    if (!missing.length) return [];
    if (!present.length || missing.length > installed.length / 2) {
      logger.warn('[discord] READY lists far fewer servers than are installed; nothing removed', { installed: installed.length, present: present.length });
      return [];
    }
    for (const guildId of missing) await forgetDiscordGuild(guildId);
    logger.info('[discord] servers that removed the bot while no Gateway listened are gone', { count: missing.length });
    return missing;
  } catch (error) {
    logger.warn('[discord] server reconcile failed', { error: String(error) });
    return [];
  }
}

/** A server no project has installed for an hour: the bot leaves it. Never one it joined just now (an install in progress). */
export async function leaveIfOrphan(guildId: string, joinedAt: string | null, now = Date.now()): Promise<boolean> {
  try {
    if (!joinedAt || now - Date.parse(joinedAt) < 60 * 60_000) return false;
    const [install] = await db
      .select({ id: chatInstalls.installId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.platformTeamId, guildId)))
      .limit(1);
    if (install) return false;
    await leaveDiscordGuild(guildId);
    logger.info('[discord] left a server no project has');
    return true;
  } catch (error) {
    logger.warn('[discord] orphan server check failed', { error: String(error) });
    return false;
  }
}

/** The slash commands of the application: the chat commands, and `/connect`. */
export function discordCommandDefinitions(): Array<Record<string, unknown>> {
  const arg: Partial<Record<string, { name: string; description: string }>> = {
    model: { name: 'id', description: 'The model to switch to; leave it out for the list' },
    agent: { name: 'name', description: 'The agent to switch to; leave it out for the list' },
  };
  return [
    ...CHANNEL_COMMANDS.map((c) => ({
      name: c.name,
      description: c.description.slice(0, 100),
      ...(arg[c.name] ? { options: [{ type: 3, name: arg[c.name]!.name, description: arg[c.name]!.description, required: false }] } : {}),
    })),
    { name: 'connect', description: 'Pick the Kortix workspace this channel uses' },
  ].map((c) => ({ ...c, type: 1, contexts: [0, 1], integration_types: [0] }));
}

/** The fields of a command Kortix sets, in one order: a change to any of them registers the commands again. */
export function commandShape(c: Record<string, unknown>): string {
  const options = Array.isArray(c.options) ? (c.options as Array<Record<string, unknown>>) : [];
  const sorted = (v: unknown) => (Array.isArray(v) ? [...(v as number[])].sort() : null);
  return JSON.stringify([
    c.name,
    c.description,
    c.type ?? 1,
    sorted(c.contexts),
    sorted(c.integration_types),
    c.default_member_permissions ?? null,
    options.map((o) => [o.type, o.name, o.description, o.required ?? false]),
  ]);
}

/** The application's global commands match `discordCommandDefinitions`; a bulk overwrite when they do not. Never throws. */
export async function syncDiscordCommands(): Promise<void> {
  const want = discordCommandDefinitions();
  const path = `/applications/${config.DISCORD_APPLICATION_ID}/commands`;
  try {
    const answer = await discordCall<unknown>('GET /applications/{id}/commands', path);
    const have = Array.isArray(answer) ? (answer as Array<Record<string, unknown>>) : [];
    const haveShapes = new Set(have.map(commandShape));
    const same = have.length === want.length && want.every((w) => haveShapes.has(commandShape(w)));
    if (same) return;
    await discordCall('PUT /applications/{id}/commands', path, { method: 'PUT', body: want });
    logger.info('[discord] slash commands registered', { count: want.length });
  } catch (error) {
    logger.warn('[discord] slash commands not registered', { error: String(error) });
  }
}

/** What a resume needs: Discord keeps a session for a few minutes after its connection closes. */
export interface GatewayState {
  sessionId: string;
  resumeUrl: string | null;
  /** The last sequence fully taken: a resume replays everything after it. */
  seq: number | null;
  botUserId: string | null;
  /** The bot's role in each guild: a resume sends no GUILD_CREATE to learn them again. */
  botRoles?: Record<string, string>;
  savedAt: number;
}

/**
 * Discord allows 1,000 identifies a day; past them it ends every session and
 * resets the bot token. Milliseconds to wait before the next identify, 0 to
 * go now. Discord unreachable: 0, the connect finds out. Never throws.
 */
export async function identifyWait(): Promise<number> {
  try {
    const bot = await discordCall<{ session_start_limit?: { remaining?: number; reset_after?: number } } | null>('GET /gateway/bot', '/gateway/bot', {
      timeoutMs: 5_000,
    });
    const limit = bot?.session_start_limit;
    if (limit && typeof limit.remaining === 'number' && limit.remaining < 1) {
      return Math.min(Math.max(limit.reset_after ?? 60_000, 1_000), 24 * 60 * 60_000);
    }
  } catch {
    // The connect tries, and its close says what is wrong.
  }
  return 0;
}

/** Where the leader keeps its session, so the next leader (a deploy, a failover) resumes it and Discord replays the gap. */
export interface GatewayStateStore {
  load(): Promise<GatewayState | null>;
  save(state: GatewayState): Promise<void>;
}

const STATE_KEY = 'discord.gateway';
/** A saved session older than this is not tried: Discord has dropped it, and a resume would only fail first. */
const RESUMABLE_FOR_MS = 2 * 60_000;

export const dbGatewayStateStore: GatewayStateStore = {
  async load() {
    const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, STATE_KEY)).limit(1);
    const v = row?.value as Partial<GatewayState> | undefined;
    return v && typeof v.sessionId === 'string' && typeof v.savedAt === 'number' ? (v as GatewayState) : null;
  },
  async save(state) {
    await db
      .insert(platformSettings)
      .values({ key: STATE_KEY, value: state, updatedAt: new Date() })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: state, updatedAt: new Date() } });
  },
};

/** The leader's one Gateway connection. */

/**
 * The resume URL Discord's READY named, when it is a Discord Gateway host (or
 * the configured Gateway's own host, a test double). A resume sends the bot
 * token to that URL, so a stored or relayed value that names any other host is
 * dropped and the session identifies on the configured Gateway instead.
 */
export function trustedResumeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const configured = new URL(config.DISCORD_GATEWAY_URL);
    const discord = parsed.protocol === 'wss:' && (parsed.hostname === 'discord.gg' || parsed.hostname.endsWith('.discord.gg'));
    const configuredHost = parsed.protocol === configured.protocol && parsed.host === configured.host;
    return discord || configuredHost ? url : null;
  } catch {
    return null;
  }
}

/** HELLO's heartbeat interval, bounded to 1 s – 2 min (Discord sends ~41 s). */
export function heartbeatIntervalMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 1_000), 120_000) : 41_250;
}

export class DiscordGateway {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private stopped = true;
  /** A close Discord calls fatal (a bad token): no reconnect until the process restarts. */
  fatal = false;
  /** The connection asks for the Message Content intent: off after Discord refused it (4014). */
  messageContent = config.DISCORD_MESSAGE_CONTENT;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Each channel's intakes, one after another: Discord's order. */
  private readonly chains = new Map<string, Promise<void>>();
  /** The sequences of messages whose intake has not finished. */
  private readonly pending = new Set<number>();
  botUserId: string | null = null;
  /** The last time Discord acknowledged a heartbeat or sent an event. */
  lastSeen = 0;

  constructor(
    private readonly onMessage: (m: GatewayMessage, botUserId: string, opts: { messageContent: boolean }) => Promise<unknown> = intakeMessage,
    private readonly store: GatewayStateStore = dbGatewayStateStore,
    private readonly opts: { retryDelaysMs?: number[]; stopWaitMs?: number } = {},
  ) {}

  /** Resumes the session the last leader saved when it is fresh enough, else identifies. */
  async start(): Promise<void> {
    // After a fatal close every identify fails the same way, and over 1,000 identifies a day reset the token.
    if (!this.stopped || this.fatal || !discordConfigured()) return;
    this.stopped = false;
    const saved = await this.store.load().catch(() => null);
    if (saved && Date.now() - saved.savedAt < RESUMABLE_FOR_MS && !this.sessionId) {
      this.sessionId = saved.sessionId;
      this.resumeUrl = saved.resumeUrl;
      this.seq = saved.seq;
      this.botUserId = saved.botUserId;
      for (const [guildId, roleId] of Object.entries(saved.botRoles ?? {})) rememberBotRole(guildId, roleId);
    }
    if (this.stopped) return;
    void this.connect(this.sessionId !== null);
  }

  /**
   * Takes no more events, waits for the intakes in flight (up to 10 s), saves
   * the session and closes so Discord keeps it for a resume; no reconnect follows.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    const inFlight = [...this.chains.values()];
    if (inFlight.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => (timer = setTimeout(resolve, this.opts.stopWaitMs ?? 10_000))),
      ]);
      clearTimeout(timer);
    }
    await this.saveState();
    const ws = this.ws;
    this.ws = null;
    ws?.close(RESUME_CLOSE, 'stopping');
  }

  /** The sequence a resume starts after: before the first message still being taken, so the next leader takes it again. */
  private resumeSeq(): number | null {
    return this.pending.size ? Math.min(...this.pending) - 1 : this.seq;
  }

  private async saveState(): Promise<void> {
    if (!this.sessionId) return;
    await this.store
      .save({
        sessionId: this.sessionId,
        resumeUrl: this.resumeUrl,
        seq: this.resumeSeq(),
        botUserId: this.botUserId,
        botRoles: Object.fromEntries(botRoles),
        savedAt: Date.now(),
      })
      .catch((error) => logger.warn('[discord] Gateway session not saved', { error: String(error) }));
  }

  /** Open, or opening: a check that sees neither starts over. */
  get connected(): boolean {
    return this.ws !== null || this.reconnectTimer !== null;
  }

  private async connect(resume: boolean): Promise<void> {
    if (this.stopped) return;
    if (!resume) {
      const wait = await identifyWait();
      if (this.stopped) return;
      if (wait > 0) {
        logger.error('[discord] the day\'s Gateway identifies are spent; the next waits for Discord\'s reset', { waitMs: wait });
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.connect(false);
        }, wait);
        return;
      }
    }
    const base = (resume && trustedResumeUrl(this.resumeUrl)) || config.DISCORD_GATEWAY_URL;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base.replace(/\/+$/, '')}/?v=10&encoding=json`);
    } catch (error) {
      logger.warn('[discord] Gateway connection not opened', { error: String(error) });
      return this.scheduleReconnect(false);
    }
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String(event.data)) as GatewayPayload;
      } catch {
        return;
      }
      this.handle(ws, payload, resume);
    });
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearHeartbeat();
      if (this.stopped) return;
      if (event.code === DISALLOWED_INTENTS && this.messageContent) {
        // Mentions and DMs need no privileged intent: they keep working without it.
        this.messageContent = false;
        this.sessionId = null;
        this.seq = null;
        logger.error('[discord] Discord refused the Message Content intent; the Gateway runs without it', {
          hint: 'DISCORD_MESSAGE_CONTENT is on but the application lacks the Message Content intent: turn it on in the Developer Portal, or unset DISCORD_MESSAGE_CONTENT',
        });
        return this.scheduleReconnect(false);
      }
      if (FATAL_CLOSES.has(event.code)) {
        this.stopped = true;
        this.fatal = true;
        logger.error('[discord] the Gateway refused the bot; messages stop until it is fixed', {
          code: event.code,
          hint:
            event.code === 4004
              ? 'DISCORD_BOT_TOKEN is wrong'
              : event.code === 4011
                ? 'the bot is in too many servers for one shard: sharding is needed'
                : undefined,
        });
        return;
      }
      if (NEW_SESSION_CLOSES.has(event.code)) {
        this.sessionId = null;
        this.seq = null;
      }
      this.scheduleReconnect(this.sessionId !== null);
    });
    ws.addEventListener('error', () => {
      // A close follows; it reconnects.
    });
  }

  private scheduleReconnect(resume: boolean): void {
    // 1 s, 2 s, 4 s … up to 60 s, with jitter.
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempts, 6)) * (0.5 + Math.random() / 2);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(resume);
    }, delay);
  }

  /** Leave a connection now, without waiting for its close (a zombie may never send one), and connect again. */
  private reconnectNow(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.clearHeartbeat();
    ws.close(RESUME_CLOSE, reason);
    if (!this.stopped) this.scheduleReconnect(this.sessionId !== null);
  }

  private send(ws: WebSocket, op: number, d: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private handle(ws: WebSocket, payload: GatewayPayload, resume: boolean): void {
    // A stopping leader takes no more: its saved sequence stays before them, so the next leader gets them.
    if (this.stopped) return;
    if (typeof payload.s === 'number') this.seq = payload.s;
    this.lastSeen = Date.now();
    switch (payload.op) {
      case 10: {
        const interval = heartbeatIntervalMs((payload.d as { heartbeat_interval?: unknown })?.heartbeat_interval);
        this.clearHeartbeat();
        this.acked = true;
        setTimeout(() => this.send(ws, 1, this.seq), interval * Math.random());
        this.heartbeat = setInterval(() => {
          // No acknowledgement since the last beat: a zombie connection. Resume on a new one.
          if (!this.acked) return this.reconnectNow(ws, 'heartbeat not acknowledged');
          this.acked = false;
          this.send(ws, 1, this.seq);
          // A leader that dies without a stop leaves a session at most one beat old.
          void this.saveState();
        }, interval);
        if (resume && this.sessionId) {
          this.send(ws, 6, { token: config.DISCORD_BOT_TOKEN, session_id: this.sessionId, seq: this.seq });
        } else {
          this.send(ws, 2, {
            token: config.DISCORD_BOT_TOKEN,
            intents: discordIntents(this.messageContent),
            properties: { os: process.platform, browser: 'kortix', device: 'kortix' },
          });
        }
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        return this.send(ws, 1, this.seq);
      case 7:
        // Discord asks for a reconnect: resume on a new connection.
        return this.reconnectNow(ws, 'reconnect requested');
      case 9: {
        // An invalid session: resume when Discord says it may, else identify after 1–5 s.
        if (!payload.d) {
          this.sessionId = null;
          this.seq = null;
        }
        return void setTimeout(() => this.reconnectNow(ws, 'invalid session'), 1_000 + Math.random() * 4_000);
      }
      case 0:
        return void this.dispatch(payload.t ?? '', payload.d, typeof payload.s === 'number' ? payload.s : null);
    }
  }

  /** Take a message after the earlier ones of its channel, and keep its sequence pending until it is taken. */
  private intake(m: GatewayMessage, seq: number | null): Promise<void> {
    const channelId = m.channel_id ?? '';
    if (seq !== null) this.pending.add(seq);
    const run: Promise<void> = (this.chains.get(channelId) ?? Promise.resolve())
      .then(() => this.intakeWithRetry(m))
      .finally(() => {
        if (seq !== null) this.pending.delete(seq);
        if (this.chains.get(channelId) === run) this.chains.delete(channelId);
      });
    this.chains.set(channelId, run);
    return run;
  }

  /** The intake, tried again after 1 s, 4 s and 15 s: the Gateway never sends a message twice. */
  private async intakeWithRetry(m: GatewayMessage): Promise<void> {
    const delays = this.opts.retryDelaysMs ?? [1_000, 4_000, 15_000];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.onMessage(m, this.botUserId!, { messageContent: this.messageContent });
        return;
      } catch (error) {
        // Logged without the message's text.
        const name = error instanceof Error ? error.name : 'unknown';
        // A stopped leader saved this message's sequence as not taken: the next leader takes it.
        if (this.stopped) return;
        const delay = delays[attempt];
        if (delay === undefined) {
          logger.error('[discord] a message was not stored after every try', { error: name, attempts: attempt + 1 });
          await tellNotTaken(m, this.botUserId!);
          return;
        }
        logger.warn('[discord] a message was not stored; trying again', { error: name, attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.stopped) return;
      }
    }
  }

  private async dispatch(type: string, d: unknown, seq: number | null): Promise<void> {
    const data = (d ?? {}) as Record<string, unknown>;
    switch (type) {
      case 'READY': {
        this.attempts = 0;
        this.sessionId = typeof data.session_id === 'string' ? data.session_id : null;
        this.resumeUrl = typeof data.resume_gateway_url === 'string' ? data.resume_gateway_url : null;
        this.botUserId = (data.user as { id?: string } | undefined)?.id ?? null;
        const guilds = Array.isArray(data.guilds) ? (data.guilds as Array<{ id?: string }>) : [];
        logger.info('[discord] Gateway ready', { guilds: guilds.length, messageContent: this.messageContent });
        if (guilds.length >= VERIFY_BEFORE_GUILDS) {
          logger.warn('[discord] the Kortix Discord application nears the 100 servers Discord allows an unverified app; apply for verification', {
            guilds: guilds.length,
          });
        }
        void this.saveState();
        void syncDiscordCommands();
        void reconcileGuilds(guilds.flatMap((g) => (g.id ? [g.id] : [])));
        return;
      }
      case 'RESUMED':
        this.attempts = 0;
        logger.info('[discord] Gateway resumed');
        return;
      case 'GUILD_CREATE': {
        const guildId = typeof data.id === 'string' ? data.id : undefined;
        for (const channel of [...((data.channels as unknown[]) ?? []), ...((data.threads as unknown[]) ?? [])]) {
          cacheChannel(channel as DiscordChannel, true, guildId);
        }
        if (guildId) filledGuilds.add(guildId);
        const role = ((data.roles as Array<{ id?: string; tags?: { bot_id?: string } }>) ?? []).find((r) => r.tags?.bot_id === this.botUserId);
        if (guildId && role?.id) rememberBotRole(guildId, role.id);
        if (guildId) void leaveIfOrphan(guildId, typeof data.joined_at === 'string' ? data.joined_at : null);
        return;
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        return cacheChannel(data as Partial<DiscordChannel>, true);
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE':
        if (typeof data.id === 'string') {
          channels.delete(data.id);
          void forgetDiscordChannel(data.id).catch((error) => logger.warn('[discord] deleted channel not forgotten', { error: String(error) }));
        }
        return;
      case 'THREAD_LIST_SYNC':
        for (const thread of (data.threads as unknown[]) ?? []) cacheChannel(thread as DiscordChannel, true);
        return;
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const role = data.role as { id?: string; tags?: { bot_id?: string } } | undefined;
        if (typeof data.guild_id === 'string' && role?.id && role.tags?.bot_id && role.tags.bot_id === this.botUserId) rememberBotRole(data.guild_id, role.id);
        return;
      }
      case 'GUILD_DELETE': {
        // `unavailable`: an outage, the guild comes back. Absent: the bot was removed.
        if (data.unavailable || typeof data.id !== 'string') return;
        forgetGuildCache(data.id);
        const projects = await forgetDiscordGuild(data.id).catch(() => []);
        if (projects.length) logger.info('[discord] removed from a server; its installs are gone', { projects: projects.length });
        return;
      }
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE': {
        if (!this.botUserId) return;
        const message = data as unknown as GatewayMessage;
        // An edit may add the mention its message lacked; one taken already is never stored twice.
        if (type === 'MESSAGE_UPDATE' && !freshEdit(message)) return;
        return this.intake(message, seq);
      }
    }
  }
}

// replica-local: one Gateway per process; only the leader starts it (worker/jobs/discord-gateway.ts).
export const discordGateway = new DiscordGateway();
