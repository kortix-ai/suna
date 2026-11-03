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
 * (a bad token, intents the application lacks) stops it, logged.
 *
 * The intake (`intakeMessage`) stores in the event inbox only what is written
 * to the bot: a DM, a mention, and, with the Message Content intent
 * (`DISCORD_MESSAGE_CONTENT`), any message in a thread a Kortix session holds.
 * It routes each to its project (routing.ts) first; a server with no project,
 * or more than one, hears once per channel and hour what to do instead.
 */
import { CHANNEL_COMMANDS } from '../core/command-list';
import { claimThreadCreate } from '../core/threads';
import { config } from '../../config';
import { emitIntegrationEvent } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { type DiscordChannel, discordCall, discordConfigured, isDiscordThread, snowflakeSequence } from './api';
import { findChatThread } from '../core/threads';
import { forgetDiscordGuild } from './installs';
import { resolveDiscordRoute } from './routing';
import {
  DISCORD_MESSAGE_EVENT,
  type DiscordAttachment,
  type DiscordConversation,
  type DiscordMessageEventData,
  type DiscordStoredMessage,
} from './types';

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
/** Our own close to resume: any code but 1000 and 1001 keeps the session resumable. */
const RESUME_CLOSE = 4000;
/** A channel cached from the Gateway or REST, this long. */
const CHANNEL_TTL_MS = 30 * 60_000;
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
  flags?: number;
  attachments?: DiscordAttachment[];
  mentions?: Array<{ id: string; username?: string; global_name?: string | null }>;
  sticker_items?: Array<{ name: string }>;
}

type CachedChannel = Pick<DiscordChannel, 'id' | 'type' | 'name' | 'parent_id' | 'guild_id'> & { at: number };

// replica-local: the leader's view of the channels its Gateway reported, refilled from REST on a miss.
const channels = new Map<string, CachedChannel>();

function cacheChannel(channel: Partial<DiscordChannel> & { id?: string }, guildId?: string): void {
  if (!channel.id || typeof channel.type !== 'number') return;
  channels.set(channel.id, {
    id: channel.id,
    type: channel.type,
    name: channel.name ?? null,
    parent_id: channel.parent_id ?? null,
    guild_id: channel.guild_id ?? guildId,
    at: Date.now(),
  });
}

/** A channel's type, name and parent: the Gateway's report, else `GET /channels/{id}`. Null: Discord does not show it to the bot. */
export async function discordChannelInfo(channelId: string): Promise<CachedChannel | null> {
  const cached = channels.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_TTL_MS) return cached;
  try {
    const channel = await discordCall<DiscordChannel>('GET /channels/{id}', `/channels/${channelId}`, { timeoutMs: 5_000 });
    cacheChannel(channel);
    return channels.get(channelId) ?? null;
  } catch (error) {
    logger.warn('[discord] channel not readable', { error: String(error) });
    return null;
  }
}

/** Post a notice in a channel at most once an hour. Never throws. */
async function noticeOnce(channelId: string, replyTo: string, content: string): Promise<void> {
  try {
    if (!(await claimThreadCreate(`discord:notice:${channelId}`, NOTICE_EVERY_MS))) return;
    await discordCall('POST /channels/{id}/messages', `/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content, allowed_mentions: { parse: [] }, message_reference: { message_id: replyTo, fail_if_not_exists: false } },
    });
  } catch (error) {
    logger.warn('[discord] notice not sent', { error: String(error) });
  }
}

function storedMessage(m: GatewayMessage): DiscordStoredMessage {
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
    ...(m.flags ? { flags: m.flags } : {}),
    attachments: (m.attachments ?? []).map((a) => ({
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

/** Message types a person writes: a plain message and a reply. Joins, pins and boosts are not. */
const PERSON_MESSAGE_TYPES = new Set([0, 19]);

/**
 * One Gateway message: stored as an event of its project when it is written to
 * the bot, else nothing. Throws when the store fails (the Gateway cannot
 * redeliver it; the caller logs it).
 */
export async function intakeMessage(m: GatewayMessage, botUserId: string): Promise<'stored' | 'ignored'> {
  if (!m.author?.id || m.author.bot || m.webhook_id || !PERSON_MESSAGE_TYPES.has(m.type ?? 0)) return 'ignored';
  const guildId = m.guild_id ?? null;
  let place: Omit<DiscordConversation, 'guildId'>;
  if (!guildId) {
    place = { threadId: m.channel_id, settingsId: m.channel_id, direct: true, startThread: false, addressed: true, channelName: null, threadName: null };
  } else {
    const mention = (m.mentions ?? []).some((u) => u.id === botUserId);
    const channel = await discordChannelInfo(m.channel_id);
    if (!channel) return 'ignored';
    if (isDiscordThread(channel.type)) {
      // Without the Message Content intent a thread's other messages carry no text: only a mention counts.
      if (!mention && !(config.DISCORD_MESSAGE_CONTENT && (await findChatThread({ platform: 'discord', workspaceId: guildId, threadId: m.channel_id })))) {
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
      if (!mention) return 'ignored';
      // A text or announcement channel takes a thread on the message; another (a voice channel's chat) is the conversation itself.
      const threads = channel.type === 0 || channel.type === 5;
      place = {
        threadId: threads ? m.id : m.channel_id,
        settingsId: m.channel_id,
        direct: false,
        startThread: threads,
        addressed: true,
        channelName: channel.name ?? null,
        threadName: null,
      };
    }
  }

  const route = await resolveDiscordRoute({
    guildId,
    channelId: place.settingsId,
    ...(guildId && place.threadId === m.channel_id && place.threadId !== place.settingsId ? { threadId: m.channel_id } : {}),
    userId: m.author.id,
  });
  if (route.kind !== 'project') {
    if (!place.addressed) return 'ignored';
    const text =
      route.kind === 'ambiguous'
        ? `More than one Kortix project can answer ${guildId ? 'in this channel' : 'you here'}. Use /connect to pick one.`
        : guildId
          ? 'This server is not connected to a Kortix project. A project admin connects it under Customize → Connectors → Channels → Discord.'
          : `Kortix does not know your Discord account yet. Ask a Kortix project admin to allow your Discord user id ${m.author.id} under Customize → Connectors → Channels → Discord.`;
    await noticeOnce(m.channel_id, m.id, text);
    return 'ignored';
  }
  const data: DiscordMessageEventData = { message: storedMessage(m), conversation: { ...place, guildId: route.guildId }, botUserId };
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
    { name: 'connect', description: 'Pick the Kortix project this channel uses' },
  ].map((c) => ({ ...c, type: 1, contexts: [0, 1], integration_types: [0] }));
}

/** The application's global commands match `discordCommandDefinitions`; a bulk overwrite when they do not. Never throws. */
export async function syncDiscordCommands(): Promise<void> {
  const want = discordCommandDefinitions();
  const path = `/applications/${config.DISCORD_APPLICATION_ID}/commands`;
  try {
    const have = await discordCall<Array<{ name: string; description: string; options?: unknown[] }>>('GET /applications/{id}/commands', path);
    const shape = (c: { name: string; description: string; options?: unknown[] }) => JSON.stringify([c.name, c.description, (c.options ?? []).length]);
    const same = have.length === want.length && want.every((w) => have.some((h) => shape(h) === shape(w as never)));
    if (same) return;
    await discordCall('PUT /applications/{id}/commands', path, { method: 'PUT', body: want });
    logger.info('[discord] slash commands registered', { count: want.length });
  } catch (error) {
    logger.warn('[discord] slash commands not registered', { error: String(error) });
  }
}

/** The leader's one Gateway connection. */
export class DiscordGateway {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  botUserId: string | null = null;
  /** The last time Discord acknowledged a heartbeat or sent an event. */
  lastSeen = 0;

  constructor(private readonly onMessage: (m: GatewayMessage, botUserId: string) => Promise<unknown> = intakeMessage) {}

  start(): void {
    if (!this.stopped || !discordConfigured()) return;
    this.stopped = false;
    this.connect(false);
  }

  /** Closes so Discord keeps the session for a resume; no reconnect follows. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close(RESUME_CLOSE, 'stopping');
  }

  /** Open, or opening: a check that sees neither starts over. */
  get connected(): boolean {
    return this.ws !== null;
  }

  private connect(resume: boolean): void {
    if (this.stopped) return;
    const base = (resume && this.resumeUrl) || config.DISCORD_GATEWAY_URL;
    const ws = new WebSocket(`${base.replace(/\/+$/, '')}/?v=10&encoding=json`);
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
      if (FATAL_CLOSES.has(event.code)) {
        this.stopped = true;
        logger.error('[discord] the Gateway refused the bot; messages stop until it is fixed', {
          code: event.code,
          hint: event.code === 4014 ? 'enable the Message Content intent of the Kortix Discord application' : event.code === 4004 ? 'DISCORD_BOT_TOKEN is wrong' : undefined,
        });
        return;
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
      this.connect(resume);
    }, delay);
  }

  private send(ws: WebSocket, op: number, d: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private handle(ws: WebSocket, payload: GatewayPayload, resume: boolean): void {
    if (typeof payload.s === 'number') this.seq = payload.s;
    this.lastSeen = Date.now();
    switch (payload.op) {
      case 10: {
        const interval = (payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250;
        this.clearHeartbeat();
        this.acked = true;
        setTimeout(() => this.send(ws, 1, this.seq), interval * Math.random());
        this.heartbeat = setInterval(() => {
          // No acknowledgement since the last beat: a zombie connection. Resume on a new one.
          if (!this.acked) return void ws.close(RESUME_CLOSE, 'heartbeat not acknowledged');
          this.acked = false;
          this.send(ws, 1, this.seq);
        }, interval);
        if (resume && this.sessionId) {
          this.send(ws, 6, { token: config.DISCORD_BOT_TOKEN, session_id: this.sessionId, seq: this.seq });
        } else {
          this.send(ws, 2, {
            token: config.DISCORD_BOT_TOKEN,
            intents: discordIntents(),
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
        return void ws.close(RESUME_CLOSE, 'reconnect requested');
      case 9: {
        // An invalid session: resume when Discord says it may, else identify after 1–5 s.
        if (!payload.d) {
          this.sessionId = null;
          this.seq = null;
        }
        return void setTimeout(() => ws.close(RESUME_CLOSE, 'invalid session'), 1_000 + Math.random() * 4_000);
      }
      case 0:
        return void this.dispatch(payload.t ?? '', payload.d);
    }
  }

  private async dispatch(type: string, d: unknown): Promise<void> {
    const data = (d ?? {}) as Record<string, unknown>;
    switch (type) {
      case 'READY': {
        this.attempts = 0;
        this.sessionId = typeof data.session_id === 'string' ? data.session_id : null;
        this.resumeUrl = typeof data.resume_gateway_url === 'string' ? data.resume_gateway_url : null;
        this.botUserId = (data.user as { id?: string } | undefined)?.id ?? null;
        logger.info('[discord] Gateway ready', { guilds: Array.isArray(data.guilds) ? data.guilds.length : 0 });
        void syncDiscordCommands();
        return;
      }
      case 'RESUMED':
        this.attempts = 0;
        return;
      case 'GUILD_CREATE': {
        const guildId = typeof data.id === 'string' ? data.id : undefined;
        for (const channel of [...((data.channels as unknown[]) ?? []), ...((data.threads as unknown[]) ?? [])]) {
          cacheChannel(channel as DiscordChannel, guildId);
        }
        return;
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        return cacheChannel(data as Partial<DiscordChannel>);
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE':
        if (typeof data.id === 'string') channels.delete(data.id);
        return;
      case 'THREAD_LIST_SYNC':
        for (const thread of (data.threads as unknown[]) ?? []) cacheChannel(thread as DiscordChannel);
        return;
      case 'GUILD_DELETE': {
        // `unavailable`: an outage, the guild comes back. Absent: the bot was removed.
        if (data.unavailable || typeof data.id !== 'string') return;
        const projects = await forgetDiscordGuild(data.id).catch(() => []);
        if (projects.length) logger.info('[discord] removed from a server; its installs are gone', { projects: projects.length });
        return;
      }
      case 'MESSAGE_CREATE': {
        if (!this.botUserId) return;
        try {
          await this.onMessage(data as unknown as GatewayMessage, this.botUserId);
        } catch (error) {
          // The Gateway does not redeliver: the message is lost. Logged without its text.
          logger.error('[discord] a message was not stored', { error: error instanceof Error ? error.name : 'unknown' });
        }
        return;
      }
    }
  }
}

// replica-local: one Gateway per process; only the leader starts it (worker/jobs/discord-gateway.ts).
export const discordGateway = new DiscordGateway();
