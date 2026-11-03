/**
 * What the Discord adapter stores in the event inbox: a message the Gateway
 * delivered and an interaction the webhook received, each with the
 * conversation it belongs to. Only the fields a handler reads: never a member
 * list, never another message's text.
 */
import type { DiscordUser } from './api';

export const DISCORD_MESSAGE_EVENT = 'discord.message.created';
export const DISCORD_INTERACTION_EVENT = 'discord.interaction.created';

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  /** A signed CDN URL that expires: read once, never logged. */
  url: string;
  content_type?: string;
  /** Present on a voice message. */
  duration_secs?: number;
}

export interface DiscordStoredMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  /** The sender's server nickname. */
  nick?: string | null;
  content: string;
  /** A forward's message or a poll, as text: the sender sent it, so it is theirs and untrusted. */
  carried?: string;
  /** `MessageFlags`: 8192 marks a voice message. */
  flags?: number;
  attachments: DiscordAttachment[];
  /** The users the message mentions: their ids and names, to show `<@id>` as a name. */
  mentions: Array<Pick<DiscordUser, 'id' | 'username' | 'global_name'>>;
  stickers: string[];
  /** The message mentioned the app's role, not the app: Discord may send it without its text. */
  viaRole?: boolean;
}

/** Where a message or interaction runs, as the intake or the webhook found it. */
export interface DiscordConversation {
  /** The install the route chose: the conversation's workspace and access scope. */
  guildId: string;
  /** The channel Kortix posts in and the conversation key: a thread, a DM, or a channel without threads. */
  threadId: string;
  /** The settings channel: a thread's parent, a DM or the channel itself. */
  settingsId: string;
  /** A direct message. */
  direct: boolean;
  /** A mention in a channel that takes threads: Kortix starts a thread on the message, whose id is the message's. */
  startThread: boolean;
  /** The message was written to the bot: a DM or a mention. A thread's other messages are not. */
  addressed: boolean;
  /** Names for the prompt and the Channels page; from Discord, so untrusted. */
  channelName: string | null;
  threadName: string | null;
}

/** An interaction, trimmed. `token` answers it for 15 minutes; it is never logged. */
export interface DiscordStoredInteraction {
  id: string;
  /** 2 a slash command, 3 a component. */
  type: number;
  token: string;
  channel_id: string;
  guild_id?: string;
  user: DiscordUser;
  /** A slash command's name and options. */
  command?: { name: string; arg: string };
  /** A component's `custom_id`, or a select's chosen value. */
  custom_id?: string;
  /** The message a component is on. */
  message_id?: string;
}

export interface DiscordMessageEventData {
  message: DiscordStoredMessage;
  conversation: DiscordConversation;
  /** The bot's own user id: a mention of it is stripped from the text. */
  botUserId: string;
  /** The Gateway read every message of a held thread (the Message Content intent). Absent: the deployment's setting. */
  messageContent?: boolean;
}

export interface DiscordInteractionEventData {
  interaction: DiscordStoredInteraction;
  conversation: DiscordConversation;
}
