/**
 * One descriptor per chat channel: the facts the API, the manifest schema and
 * the web read instead of repeating them. To add a channel, add its id and its
 * descriptor here; `tsc` then names every record that needs a value for it.
 *
 * No imports, so the dependency-free manifest constants can read it. Not in the
 * package root: `channel-message.ts` already exports `CHANNEL_PLATFORMS` there.
 */

/** The `platform` of a `channel` connector. The order is the manifest schema's enum order. */
export const CHANNEL_PLATFORM_IDS = ['slack', 'teams', 'email', 'telegram'] as const;
export type ChannelPlatformId = (typeof CHANNEL_PLATFORM_IDS)[number];

export interface ChannelDescriptor {
  /** The display name. */
  label: string;
  /** The platform word of a prompt header, `[<envelope> · …]`. Transcripts store it: never rename one. */
  envelope: string;
  /** The `native:<id>` catalog card. Its icon is `/connector-icons/<id>.svg`. */
  catalog: { domain: string; description: string };
  /** The most characters one message holds. */
  messageChars?: number;
  /** One tap per option up to `max` options. `dataBytes`: the platform's cap on a button's data. */
  buttons?: { max: number; dataBytes?: number };
  /** The token a person pastes to connect. */
  connect?: { tokenPattern: RegExp; tokenPlaceholder: string };
  /** Senders pass an allow-list of these user ids. */
  access?: { userId: RegExp; idPlaceholder: string; idsPlaceholder: string; idInputMode: 'numeric' | 'text' };
}

export const CHANNELS = {
  slack: {
    label: 'Slack',
    envelope: 'Slack',
    catalog: {
      domain: 'slack.com',
      description: 'Message the agent in Slack: mentions, DMs and channels, through the Kortix Slack app.',
    },
  },
  teams: {
    label: 'Microsoft Teams',
    envelope: 'Teams',
    catalog: {
      domain: 'teams.microsoft.com',
      description: 'Message the agent in Microsoft Teams chats and channels, through the Kortix Teams app.',
    },
    buttons: { max: 6 },
  },
  email: {
    label: 'Email',
    envelope: 'Email',
    catalog: { domain: 'email.kortix', description: 'Give the project an inbox: people email the agent and it replies.' },
  },
  telegram: {
    label: 'Telegram',
    envelope: 'Telegram',
    catalog: { domain: 'telegram.org', description: 'Message the agent from Telegram through a bot you own.' },
    messageChars: 4096,
    buttons: { max: 6, dataBytes: 64 },
    // A bot token is `<bot id>:<secret>`.
    connect: { tokenPattern: /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, tokenPlaceholder: '123456789:…' },
    access: {
      userId: /^\d{1,20}$/,
      idPlaceholder: '123456789',
      idsPlaceholder: '123456789, 987654321',
      idInputMode: 'numeric',
    },
  },
} as const satisfies Record<ChannelPlatformId, ChannelDescriptor>;

/** The reserved slug a channel's built-in connector uses, so a user connector cannot take it. */
export const channelConnectorSlug = <P extends ChannelPlatformId>(platform: P) => `kortix_${platform}` as const;

export const isChannelPlatform = (platform: string): platform is ChannelPlatformId =>
  (CHANNEL_PLATFORM_IDS as readonly string[]).includes(platform);
