/**
 * Discord's interactions webhook on the shared route (channels/inbound),
 * mounted at `/v1/webhooks/discord`: the Interactions Endpoint URL of the
 * Kortix Discord application, one URL for every project. Discord signs each
 * request with the application's Ed25519 key and wants an answer within 3
 * seconds, so the webhook answers at once and the event inbox does the work:
 *
 *   PING            → PONG (Discord checks the URL with it)
 *   /connect        → the project buttons, now, only the sender sees them (connect.ts)
 *   another command → a deferred reply (5); the consumer draws it (session.ts)
 *   a press         → a deferred update (6); the consumer acts on it
 *   no project      → a notice only the sender sees
 *
 * Importing ./session also registers the `discord.` event consumer.
 */
import { createPublicKey, verify } from 'node:crypto';
import { config } from '../../config';
import type { IntegrationEvent } from '../../integrations/event-inbox';
import type { ChannelAppInbound, InboundReply } from '../inbound/inbound';
import { type DiscordChannel, type DiscordUser, isDiscordThread, snowflakeSequence } from './api';
import { connectReply, isProjectPress, parseProjectPress } from './connect';
import { discordGuildProjects } from './installs';
import { type DiscordRoute, projectsAllowing, resolveDiscordRoute } from './routing';
import { interactionPressData } from './session';
import { DISCORD_INTERACTION_EVENT, type DiscordConversation, type DiscordStoredInteraction } from './types';

/** A signature older or newer than this is refused: a replayed request. */
const SIGNATURE_WINDOW_S = 10 * 60;
const EPHEMERAL = 64;

/** The raw 32-byte Ed25519 key as a key object (its SPKI DER: a fixed 12-byte prefix, then the key). */
function publicKey(hex: string) {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

let cachedKey: { hex: string; key: ReturnType<typeof publicKey> } | null = null;

/** Discord's signature over the timestamp and the raw body, with the application's public key. */
export function discordSignatureValid(rawBody: string, signature: string, timestamp: string, keyHex = config.DISCORD_PUBLIC_KEY): boolean {
  if (!/^[0-9a-f]{128}$/i.test(signature) || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(keyHex)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_WINDOW_S) return false;
  if (cachedKey?.hex !== keyHex) cachedKey = { hex: keyHex, key: publicKey(keyHex) };
  try {
    return verify(null, Buffer.from(timestamp + rawBody), cachedKey.key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** The fields of an interaction the webhook reads. */
interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: Pick<DiscordChannel, 'id' | 'type' | 'name' | 'parent_id'>;
  member?: { user?: DiscordUser; nick?: string | null };
  user?: DiscordUser;
  message?: { id: string };
  data?: {
    name?: string;
    options?: Array<{ name: string; type: number; value?: unknown }>;
    custom_id?: string;
    component_type?: number;
    values?: unknown;
  };
}

const ephemeral = (content: string): InboundReply => ({ status: 200, body: { type: 4, data: { content, flags: EPHEMERAL } } });

const NOT_CONNECTED: Record<Exclude<DiscordRoute['kind'], 'project'>, (direct: boolean) => string> = {
  ambiguous: (direct) =>
    `More than one Kortix project can answer ${direct ? 'you here' : 'in this channel'}. Use /connect to pick one.`,
  none: (direct) =>
    direct
      ? 'No Kortix project allows your Discord account yet. Ask a project admin to allow your Discord user id under Customize → Connectors → Channels → Discord.'
      : 'This server is not connected to a Kortix project. A project admin connects it under Customize → Connectors → Channels → Discord.',
};

/** The conversation an interaction runs in: a thread, a DM, or the channel itself. */
function conversationOf(interaction: Interaction, guildId: string): DiscordConversation {
  const channelId = interaction.channel_id ?? interaction.channel?.id ?? '';
  const inThread = interaction.channel ? isDiscordThread(interaction.channel.type) : false;
  return {
    guildId,
    threadId: channelId,
    settingsId: inThread ? (interaction.channel?.parent_id ?? channelId) : channelId,
    direct: !interaction.guild_id,
    startThread: false,
    addressed: true,
    channelName: inThread ? null : (interaction.channel?.name ?? null),
    threadName: inThread ? (interaction.channel?.name ?? null) : null,
  };
}

function routeOf(interaction: Interaction, user: DiscordUser): Promise<DiscordRoute> {
  const channelId = interaction.channel_id ?? '';
  const inThread = interaction.channel ? isDiscordThread(interaction.channel.type) : false;
  return resolveDiscordRoute({
    guildId: interaction.guild_id ?? null,
    channelId: inThread ? (interaction.channel?.parent_id ?? channelId) : channelId,
    ...(inThread ? { threadId: channelId } : {}),
    userId: user.id,
  });
}

/** The project a `kd:` press picks, with its guild: one the server installed, or one that allows the DM's person. */
async function pickedProject(interaction: Interaction, user: DiscordUser, projectId: string): Promise<{ projectId: string; guildId: string } | null> {
  if (!projectId) return null;
  if (interaction.guild_id) {
    return (await discordGuildProjects(interaction.guild_id)).includes(projectId) ? { projectId, guildId: interaction.guild_id } : null;
  }
  return (await projectsAllowing(user.id)).find((p) => p.projectId === projectId) ?? null;
}

/** A slash command's argument: its first string option (`/model id:<value>`). */
function commandArg(interaction: Interaction): string {
  const option = interaction.data?.options?.find((o) => o.type === 3 && typeof o.value === 'string');
  return typeof option?.value === 'string' ? option.value.trim() : '';
}

function interactionEvent(interaction: Interaction, user: DiscordUser, projectId: string, conversation: DiscordConversation, pressData?: string): IntegrationEvent {
  const stored: DiscordStoredInteraction = {
    id: interaction.id,
    type: interaction.type,
    token: interaction.token,
    channel_id: conversation.threadId,
    ...(interaction.guild_id ? { guild_id: interaction.guild_id } : {}),
    user: { id: user.id, ...(user.username ? { username: user.username } : {}), ...(user.global_name ? { global_name: user.global_name } : {}) },
    ...(interaction.type === 2 ? { command: { name: interaction.data?.name ?? '', arg: commandArg(interaction) } } : {}),
    ...(pressData !== undefined ? { custom_id: pressData } : {}),
    ...(interaction.message?.id ? { message_id: interaction.message.id } : {}),
  };
  return {
    id: interaction.id,
    source: `discord:${interaction.guild_id ?? 'dm'}`,
    type: DISCORD_INTERACTION_EVENT,
    time: new Date().toISOString(),
    // The conversation's order: a press waits for the messages sent before it there.
    subject: conversation.threadId,
    sequence: snowflakeSequence(interaction.id),
    projectId,
    data: { interaction: stored, conversation } as unknown as Record<string, unknown>,
  };
}

export const discordInbound: ChannelAppInbound<true> = {
  platform: 'discord',
  summary: 'Discord interactions webhook (Ed25519 signature verified)',
  // An interaction's token answers for 15 minutes: a later retry could not reply.
  maxAttempts: 4,
  async verify({ header, rawBody }) {
    if (!config.DISCORD_PUBLIC_KEY) return { status: 404, body: { error: 'Not configured' } };
    const valid = discordSignatureValid(rawBody, header('x-signature-ed25519') ?? '', header('x-signature-timestamp') ?? '');
    return valid ? { verified: true } : { status: 401, body: { error: 'invalid request signature' } };
  },
  async normalize(body) {
    const interaction = body as Interaction;
    if (interaction.type === 1) return { events: [], reply: { status: 200, body: { type: 1 } } };
    const user = interaction.member?.user ?? interaction.user;
    if (!user?.id || !interaction.id || !interaction.token || !interaction.channel_id) return { events: [], reply: ephemeral('Kortix could not read this request.') };
    const direct = !interaction.guild_id;

    if (interaction.type === 2 && interaction.data?.name === 'connect') {
      const choice = await connectReply({ guildId: interaction.guild_id ?? null, userId: user.id });
      return { events: [], reply: { status: 200, body: { type: 4, data: { ...choice, flags: EPHEMERAL } } } };
    }
    if (interaction.type !== 2 && interaction.type !== 3) return { events: [], reply: ephemeral('Kortix does not answer this here.') };

    const pressData = interaction.type === 3 ? interactionPressData(interaction.data?.custom_id ?? '', interaction.data?.values) : undefined;
    const ack: InboundReply = { status: 200, body: { type: interaction.type === 2 ? 5 : 6 } };
    if (pressData !== undefined && isProjectPress(pressData)) {
      const picked = await pickedProject(interaction, user, parseProjectPress(pressData));
      if (!picked) return { events: [], reply: ephemeral('This project button is out of date. Use /connect again.') };
      return { events: [interactionEvent(interaction, user, picked.projectId, conversationOf(interaction, picked.guildId), pressData)], reply: ack };
    }
    const route = await routeOf(interaction, user);
    if (route.kind !== 'project') return { events: [], reply: ephemeral(NOT_CONNECTED[route.kind](direct)) };
    return { events: [interactionEvent(interaction, user, route.projectId, conversationOf(interaction, route.guildId), pressData)], reply: ack };
  },
};
