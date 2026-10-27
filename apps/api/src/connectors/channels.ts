/**
 * Channel connectors — chat platforms (Slack today; Telegram/Teams next) as
 * first-class connectors. Unlike the spec-driven providers, a channel's
 * catalog is a FIXED, hand-curated set of actions (the platform's stable API
 * surface), and its credential is the platform's existing install token,
 * resolved server-side from the install-store (no connection_credentials row, no
 * data migration). Each action is a plain `http` binding against the platform's
 * API base, so the gateway's existing executeCall runs them unchanged. The
 * Slack catalog mirrors the in-sandbox `slack` CLI 1:1 for full parity. See
 * KORTIX-206.
 */
import { config } from '../config';
import type { ConnectorAuth } from './call';
import type { ActionBinding, NormalizedAction, Risk } from './types';

/**
 * Reserved, platform-owned connector slug for the built-in Slack channel.
 *
 * Do NOT use the public `slack` slug here: projects are allowed to add their
 * own `[[connectors]] slug = "slack"` (for example a Pipedream Slack connector).
 * The in-sandbox `slack` CLI needs a deterministic namespace that cannot be
 * shadowed by those user-defined connectors, otherwise read commands such as
 * `slack thread` resolve against the wrong catalog and fail with
 * `action_not_found`.
 */
export const SLACK_CHANNEL_CONNECTOR_SLUG = 'kortix_slack';
export const TEAMS_CHANNEL_CONNECTOR_SLUG = 'kortix_teams';
export const EMAIL_CHANNEL_CONNECTOR_SLUG = 'kortix_email';
export const TELEGRAM_CHANNEL_CONNECTOR_SLUG = 'kortix_telegram';

export function channelDefaultSlug(platform: string): string {
  switch (platform) {
    case 'slack':
      return SLACK_CHANNEL_CONNECTOR_SLUG;
    case 'teams':
      return TEAMS_CHANNEL_CONNECTOR_SLUG;
    case 'email':
      return EMAIL_CHANNEL_CONNECTOR_SLUG;
    case 'telegram':
      return TELEGRAM_CHANNEL_CONNECTOR_SLUG;
    default:
      return platform;
  }
}

/**
 * Per-platform credential placement.
 */
export function channelAuth(platform: string): ConnectorAuth {
  // Telegram's Bot API takes the token as the first path segment: /bot<token>/<method>.
  if (platform === 'telegram') return { type: 'custom', in: 'path', name: null, prefix: 'bot' };
  return { type: 'bearer', in: 'header', name: null, prefix: null };
}

// `ChannelPlatform` + the platform allow-list are owned by projects/connectors.ts
// (the parser layer the connector builds on). This module just maps a platform
// string → its catalog / API base, so it takes plain strings and returns []/''
// for anything it doesn't know.

/** Per-platform API base — the connector's baseUrl, where http bindings resolve. */
export function channelApiBase(platform: string): string {
  switch (platform) {
    case 'slack':
      return 'https://slack.com/api';
    case 'teams':
      return 'https://graph.microsoft.com/v1.0';
    case 'email':
      return config.RESEND_API_URL;
    case 'telegram':
      return config.TELEGRAM_API_URL;
    default:
      return '';
  }
}

/** Human label for a channel connector (UI default name). */
export function channelLabel(platform: string): string {
  switch (platform) {
    case 'slack':
      return 'Slack';
    case 'teams':
      return 'Microsoft Teams';
    case 'email':
      return 'Email';
    case 'telegram':
      return 'Telegram';
    default:
      return platform;
  }
}

/** One curated channel action — normalized into an http-bound NormalizedAction. */
interface ChannelActionDef {
  /** Connector-relative tool path (the connector namespace tail, e.g. `send_message`). */
  path: string;
  /** Platform API path/method tail. */
  method: string;
  /** HTTP verb — POST methods send a JSON body; GET methods send a query string. */
  verb: 'GET' | 'POST';
  name: string;
  description: string;
  risk: Risk;
  /** JSON-schema properties using Slack's NATIVE param names (passed through verbatim). */
  properties: Record<string, Record<string, unknown> & { type: string; description: string }>;
  required: string[];
  /** Curated defaults the provider does not apply itself; the caller's args always win. */
  defaults?: Record<string, unknown>;
}

const EMAIL_ATTACHMENT_SCHEMA = {
  type: 'array',
  description:
    'Optional attachments. Use an opaque attachment_id returned by the Connector attachment upload route, or a fetchable URL.',
  items: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Filename shown to the recipient.' },
      content_type: { type: 'string', description: 'MIME type of the attachment.' },
      content_disposition: {
        type: 'string',
        enum: ['attachment', 'inline'],
        description: 'How the recipient email client should display the file.',
      },
      content_id: { type: 'string', description: 'Optional content ID for an inline attachment.' },
      attachment_id: {
        type: 'string',
        description: 'Opaque handle returned after uploading raw bytes to the Connector.',
      },
      url: { type: 'string', description: 'URL from which the email provider can fetch the file.' },
    },
    required: ['filename'],
    anyOf: [{ required: ['attachment_id'] }, { required: ['url'] }],
    additionalProperties: false,
  },
} satisfies Record<string, unknown> & { type: string; description: string };

/**
 * The Slack catalog — one entry per native Web API method the `slack` CLI
 * exposes. Property names match Slack's API exactly (channel, ts, timestamp,
 * name, user, query, file…) so executeCall's http builder passes them straight
 * through: POST → JSON body, GET → query string, with `Authorization: Bearer`.
 *
 * NOT included here (handled outside the gateway, by design):
 *   • step / send(answer) — the turn-stream relay (Kortix-internal, kept as-is).
 *   • typing               — a Slack Web-API no-op.
 *   • download / manifest  — sandbox-FS write / server-meta fetch (CLI-side).
 *   • send --file          — multi-step external upload (CLI-side helper).
 */
const SLACK_ACTIONS: ChannelActionDef[] = [
  {
    path: 'send_message',
    method: 'chat.postMessage',
    verb: 'POST',
    name: 'Send message',
    description:
      'Post a message to a Slack channel or thread. Provide `channel` plus `text` and/or Block Kit `blocks`; set `thread_ts` to reply in a thread. From a session, the thread is bound to that session, so a human reply in it comes back to it when it @mentions the bot (any reply in a DM); `thread_binding` in the result reports whether the bind held.',
    risk: 'write',
    properties: {
      channel: { type: 'string', description: 'Channel ID (e.g. C0123) or user ID for a DM.' },
      text: {
        type: 'string',
        description:
          'Message text (mrkdwn). Also used as the notification fallback when sending blocks.',
      },
      blocks: { type: 'array', description: 'Optional Block Kit blocks for a rich message.' },
      thread_ts: { type: 'string', description: 'Optional parent message ts to reply in-thread.' },
    },
    required: ['channel'],
  },
  {
    path: 'update_message',
    method: 'chat.update',
    verb: 'POST',
    name: 'Update message',
    description: 'Edit an existing message you posted. Requires `channel` and the message `ts`.',
    risk: 'write',
    properties: {
      channel: { type: 'string', description: 'Channel ID the message is in.' },
      ts: { type: 'string', description: 'Timestamp (ts) of the message to edit.' },
      text: { type: 'string', description: 'New message text (mrkdwn).' },
      blocks: { type: 'array', description: 'Optional replacement Block Kit blocks.' },
    },
    required: ['channel', 'ts'],
  },
  {
    path: 'delete_message',
    method: 'chat.delete',
    verb: 'POST',
    name: 'Delete message',
    description: 'Delete a message you posted. Requires `channel` and the message `ts`.',
    risk: 'destructive',
    properties: {
      channel: { type: 'string', description: 'Channel ID the message is in.' },
      ts: { type: 'string', description: 'Timestamp (ts) of the message to delete.' },
    },
    required: ['channel', 'ts'],
  },
  {
    path: 'add_reaction',
    method: 'reactions.add',
    verb: 'POST',
    name: 'Add reaction',
    description:
      'Add an emoji reaction to a message. Requires `channel`, the message `timestamp`, and the emoji `name` (without colons).',
    risk: 'write',
    properties: {
      channel: { type: 'string', description: 'Channel ID the message is in.' },
      timestamp: { type: 'string', description: 'Timestamp (ts) of the target message.' },
      name: { type: 'string', description: 'Emoji name without colons, e.g. "white_check_mark".' },
    },
    required: ['channel', 'timestamp', 'name'],
  },
  {
    path: 'remove_reaction',
    method: 'reactions.remove',
    verb: 'POST',
    name: 'Remove reaction',
    description:
      'Remove an emoji reaction you added to a message. Requires `channel`, the message `timestamp`, and the emoji `name` (without colons).',
    risk: 'write',
    properties: {
      channel: { type: 'string', description: 'Channel ID the message is in.' },
      timestamp: { type: 'string', description: 'Timestamp (ts) of the target message.' },
      name: { type: 'string', description: 'Emoji name without colons, e.g. "eyes".' },
    },
    required: ['channel', 'timestamp', 'name'],
  },
  {
    path: 'get_history',
    method: 'conversations.history',
    verb: 'GET',
    name: 'Get channel history',
    description:
      'Fetch recent messages from a channel. Provide `channel`; optional `limit` (default 20).',
    risk: 'read',
    properties: {
      channel: { type: 'string', description: 'Channel ID to read.' },
      limit: { type: 'number', description: 'Max messages to return (default 20).' },
    },
    required: ['channel'],
    defaults: { limit: 20 },
  },
  {
    path: 'get_thread',
    method: 'conversations.replies',
    verb: 'GET',
    name: 'Get thread replies',
    description:
      'Fetch the replies in a thread. Requires `channel` and the thread root `ts`; optional `limit`.',
    risk: 'read',
    properties: {
      channel: { type: 'string', description: 'Channel ID the thread is in.' },
      ts: { type: 'string', description: 'Timestamp (ts) of the thread root message.' },
      limit: { type: 'number', description: 'Max replies to return (default: Slack\'s).' },
    },
    required: ['channel', 'ts'],
  },
  {
    path: 'list_channels',
    method: 'conversations.list',
    verb: 'GET',
    name: 'List channels',
    description:
      'List public + private channels the bot can see (excludes archived). Optional `limit`.',
    risk: 'read',
    properties: {
      limit: { type: 'number', description: 'Max channels to return (default 100).' },
      types: {
        type: 'string',
        description: 'Comma-separated channel types (default "public_channel,private_channel").',
      },
      exclude_archived: {
        type: 'boolean',
        description: 'Exclude archived channels (default true).',
      },
    },
    required: [],
    defaults: { types: 'public_channel,private_channel', exclude_archived: true },
  },
  {
    path: 'channel_info',
    method: 'conversations.info',
    verb: 'GET',
    name: 'Get channel info',
    description: 'Fetch metadata for a single channel. Requires `channel`.',
    risk: 'read',
    properties: {
      channel: { type: 'string', description: 'Channel ID to inspect.' },
    },
    required: ['channel'],
  },
  {
    path: 'join_channel',
    method: 'conversations.join',
    verb: 'POST',
    name: 'Join channel',
    description: 'Join a public channel so the bot can post in it. Requires `channel`.',
    risk: 'write',
    properties: {
      channel: { type: 'string', description: 'Channel ID to join.' },
    },
    required: ['channel'],
  },
  {
    path: 'list_users',
    method: 'users.list',
    verb: 'GET',
    name: 'List users',
    description: 'List workspace members. Optional `limit`.',
    risk: 'read',
    properties: {
      limit: { type: 'number', description: 'Max users to return (default: Slack\'s).' },
    },
    required: [],
  },
  {
    path: 'user_info',
    method: 'users.info',
    verb: 'GET',
    name: 'Get user info',
    description: 'Fetch a single user profile. Requires the `user` ID.',
    risk: 'read',
    properties: {
      user: { type: 'string', description: 'User ID (e.g. U0123).' },
    },
    required: ['user'],
  },
  {
    path: 'auth_test',
    method: 'auth.test',
    verb: 'POST',
    name: 'Identify bot (auth.test)',
    description:
      'Return the authenticated bot identity (user_id, team, bot_id) — the "who am I" call.',
    risk: 'read',
    properties: {},
    required: [],
  },
  {
    path: 'search_messages',
    method: 'search.messages',
    verb: 'GET',
    name: 'Search messages',
    description: 'Search messages across the workspace. Requires a `query` string.',
    risk: 'read',
    properties: {
      query: { type: 'string', description: 'Slack search query (supports in:, from:, etc.).' },
    },
    required: ['query'],
  },
  {
    path: 'file_info',
    method: 'files.info',
    verb: 'GET',
    name: 'Get file info',
    description: 'Fetch metadata for a file. Requires the `file` ID.',
    risk: 'read',
    properties: {
      file: { type: 'string', description: 'File ID (e.g. F0123).' },
    },
    required: ['file'],
  },
];

/**
 * The Email channel on Resend Inboxes. Kortix fills in `inbox_id` from the
 * connection, and inside an email session the thread and email it answers.
 * Action names predate Resend (2026-10-24) and stay; three behave differently:
 * `send_message` creates a draft that the gateway sends right away,
 * `reply_all_message` replies and copies whoever the agent lists in `cc`, and
 * `list_messages` lists the emails of one thread (Resend has no inbox-wide list).
 */
const EMAIL_ACTIONS: ChannelActionDef[] = [
  {
    path: 'send_message',
    method: 'inboxes/{inbox_id}/drafts',
    verb: 'POST',
    name: 'Send email',
    description: 'Send a new email from the inbox. It starts a new thread. Supports text/html and attachments.',
    risk: 'write',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID to send from (Kortix fills it in).' },
      to: { type: 'array', description: 'Recipient email address or addresses.' },
      cc: { type: 'array', description: 'Optional CC recipients.' },
      bcc: { type: 'array', description: 'Optional BCC recipients.' },
      subject: { type: 'string', description: 'Email subject.' },
      text: { type: 'string', description: 'Plain text body.' },
      html: { type: 'string', description: 'HTML body.' },
      attachments: EMAIL_ATTACHMENT_SCHEMA,
    },
    required: ['to'],
  },
  {
    path: 'reply_message',
    method: 'inboxes/{inbox_id}/threads/{thread_id}/emails/{message_id}/reply',
    verb: 'POST',
    name: 'Reply to email',
    description: 'Reply in the same thread as an existing email, from the inbox address.',
    risk: 'write',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      thread_id: { type: 'string', description: 'Thread ID of the email.' },
      message_id: { type: 'string', description: 'Email ID to reply to.' },
      cc: { type: 'array', description: 'Optional CC recipients.' },
      bcc: { type: 'array', description: 'Optional BCC recipients.' },
      subject: { type: 'string', description: 'Optional subject. Defaults to the thread subject with "Re:".' },
      text: { type: 'string', description: 'Plain text body.' },
      html: { type: 'string', description: 'HTML body.' },
      attachments: EMAIL_ATTACHMENT_SCHEMA,
    },
    required: ['thread_id', 'message_id'],
  },
  {
    path: 'reply_all_message',
    method: 'inboxes/{inbox_id}/threads/{thread_id}/emails/{message_id}/reply',
    verb: 'POST',
    name: 'Reply all to email',
    description:
      'Reply in the same thread and copy the other people on the email: list them in `cc` (read them with get_message first).',
    risk: 'write',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      thread_id: { type: 'string', description: 'Thread ID of the email.' },
      message_id: { type: 'string', description: 'Email ID to reply to.' },
      cc: { type: 'array', description: 'The other recipients to copy.' },
      text: { type: 'string', description: 'Plain text body.' },
      html: { type: 'string', description: 'HTML body.' },
      attachments: EMAIL_ATTACHMENT_SCHEMA,
    },
    required: ['thread_id', 'message_id'],
  },
  {
    path: 'list_messages',
    method: 'inboxes/{inbox_id}/threads/{thread_id}/emails',
    verb: 'GET',
    name: 'List thread emails',
    description: 'List the emails of one thread, oldest first, with their bodies.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      thread_id: { type: 'string', description: 'Thread ID.' },
      limit: { type: 'number', description: 'Maximum emails to return (1-100).' },
      after: { type: 'string', description: 'Cursor: the last email ID of the previous page.' },
    },
    required: ['thread_id'],
  },
  {
    path: 'get_message',
    method: 'inboxes/{inbox_id}/threads/{thread_id}/emails/{message_id}',
    verb: 'GET',
    name: 'Get email',
    description: 'Fetch one email of a thread with its body and attachment list.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      thread_id: { type: 'string', description: 'Thread ID.' },
      message_id: { type: 'string', description: 'Email ID.' },
    },
    required: ['thread_id', 'message_id'],
  },
  {
    path: 'search_messages',
    method: 'inboxes/{inbox_id}/threads/search',
    verb: 'GET',
    name: 'Search inbox',
    description:
      'Search the inbox threads by subject, body, sender, recipients and attachment names. Each result names the matching email in `matched_email_id`.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      query: { type: 'string', description: 'Search words (max 256 characters).' },
      from: { type: 'string', description: 'Optional sender filter, comma-separated.' },
      start_date: { type: 'string', description: 'Optional earliest date, e.g. 2026-09-01.' },
      limit: { type: 'number', description: 'Maximum threads to return (1-100).' },
    },
    required: ['query'],
  },
  {
    path: 'list_threads',
    method: 'inboxes/{inbox_id}/threads',
    verb: 'GET',
    name: 'List email threads',
    description: 'List the inbox threads, most recently active first.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      folders: { type: 'string', description: 'Comma-separated: inbox, archive, spam, trash, sent. Default inbox.' },
      limit: { type: 'number', description: 'Maximum threads to return (1-100).' },
      after: { type: 'string', description: 'Cursor: the last thread ID of the previous page.' },
    },
    required: [],
  },
  {
    path: 'get_thread',
    method: 'inboxes/{inbox_id}/threads/{thread_id}/emails',
    verb: 'GET',
    name: 'Get email thread',
    description: 'Fetch every email of a thread, oldest first, with their bodies.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      thread_id: { type: 'string', description: 'Thread ID.' },
    },
    required: ['thread_id'],
  },
  {
    path: 'get_message_attachment',
    method: 'emails/receiving/{message_id}/attachments/{attachment_id}',
    verb: 'GET',
    name: 'Get email attachment',
    description: 'Get a received attachment: its metadata and a `download_url` that expires (`expires_at`).',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'Inbox ID (Kortix fills it in).' },
      message_id: { type: 'string', description: 'Email ID the attachment belongs to.' },
      attachment_id: { type: 'string', description: 'Attachment ID from the email.' },
    },
    required: ['message_id', 'attachment_id'],
  },
];

function toAction(def: ChannelActionDef): NormalizedAction {
  const binding: ActionBinding = { kind: 'http', method: def.verb, path: `/${def.method}` };
  const properties: Record<string, { type: string; description: string; 'x-in'?: string }> = {};
  for (const [key, value] of Object.entries(def.properties)) {
    properties[key] = {
      ...value,
      ...(def.method.includes(`{${key}}`) ? { 'x-in': 'path' } : {}),
    };
  }
  const inputSchema = Object.keys(def.properties).length
    ? {
        type: 'object',
        properties,
        ...(def.required.length ? { required: def.required } : {}),
      }
    : null;
  return {
    path: def.path,
    name: def.name,
    description: def.description,
    inputSchema,
    outputSchema: null,
    risk: def.risk,
    binding,
  };
}

const TEAMS_ACTIONS: ChannelActionDef[] = [
  {
    path: 'get_team',
    method: 'teams/{team-id}',
    verb: 'GET',
    name: 'Get team',
    description: 'Fetch a team (Microsoft 365 group) by its id.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
    },
    required: ['team-id'],
  },
  {
    path: 'list_channels',
    method: 'teams/{team-id}/channels',
    verb: 'GET',
    name: 'List channels',
    description: 'List the channels in a team. Requires `team-id`.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
    },
    required: ['team-id'],
  },
  {
    path: 'get_channel',
    method: 'teams/{team-id}/channels/{channel-id}',
    verb: 'GET',
    name: 'Get channel',
    description: 'Fetch a single channel in a team. Requires `team-id` and `channel-id`.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
      'channel-id': { type: 'string', description: 'The channel id.' },
    },
    required: ['team-id', 'channel-id'],
  },
  {
    path: 'list_members',
    method: 'teams/{team-id}/members',
    verb: 'GET',
    name: 'List team members',
    description: 'List the members of a team. Requires `team-id`.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
    },
    required: ['team-id'],
  },
  {
    path: 'get_user',
    method: 'users/{user-id}',
    verb: 'GET',
    name: 'Get user',
    description: 'Fetch a user profile by id or userPrincipalName.',
    risk: 'read',
    properties: {
      'user-id': { type: 'string', description: 'The user id or userPrincipalName.' },
    },
    required: ['user-id'],
  },
  {
    path: 'list_teams',
    method: 'teams',
    verb: 'GET',
    name: 'List teams',
    description: 'List the teams the bot can see in the tenant.',
    risk: 'read',
    properties: {},
    required: [],
  },
  {
    path: 'list_messages',
    method: 'teams/{team-id}/channels/{channel-id}/messages',
    verb: 'GET',
    name: 'List channel messages',
    description:
      'List recent messages in a channel (history). Requires `team-id` and `channel-id`.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
      'channel-id': { type: 'string', description: 'The channel id.' },
    },
    required: ['team-id', 'channel-id'],
  },
  {
    path: 'get_message',
    method: 'teams/{team-id}/channels/{channel-id}/messages/{message-id}',
    verb: 'GET',
    name: 'Get channel message',
    description: 'Fetch a single channel message. Requires `team-id`, `channel-id`, `message-id`.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
      'channel-id': { type: 'string', description: 'The channel id.' },
      'message-id': { type: 'string', description: 'The message id.' },
    },
    required: ['team-id', 'channel-id', 'message-id'],
  },
  {
    path: 'list_replies',
    method: 'teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies',
    verb: 'GET',
    name: 'List message replies',
    description:
      'List replies to a channel message (a thread). Requires `team-id`, `channel-id`, `message-id`.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
      'channel-id': { type: 'string', description: 'The channel id.' },
      'message-id': { type: 'string', description: 'The message id.' },
    },
    required: ['team-id', 'channel-id', 'message-id'],
  },
];

/**
 * The Telegram catalog — Bot API methods, all `POST` with a JSON body. The bot
 * token is the first path segment (channelAuth), resolved server-side.
 */
const TELEGRAM_CHAT_ID = {
  type: 'string',
  description: 'Chat id (from the incoming message) or @channel_username.',
} as const;

const TELEGRAM_ACTIONS: ChannelActionDef[] = [
  {
    path: 'send_message',
    method: 'sendMessage',
    verb: 'POST',
    name: 'Send message',
    description:
      'Send a text message to a Telegram chat, at most 4096 characters; split longer answers. Set `reply_parameters.message_id` to reply to a message and `message_thread_id` to post in a forum topic. `parse_mode: "HTML"` enables <b>, <i>, <code>, <pre> and <a href>.',
    risk: 'write',
    properties: {
      chat_id: TELEGRAM_CHAT_ID,
      text: { type: 'string', description: 'Message text, 1-4096 characters.' },
      reply_parameters: { type: 'object', description: 'Optional `{ "message_id": <id> }` to reply to.' },
      message_thread_id: { type: 'integer', description: 'Optional forum topic id.' },
      parse_mode: { type: 'string', description: 'Optional `HTML` or `MarkdownV2`.' },
      reply_markup: { type: 'object', description: 'Optional inline keyboard `{ "inline_keyboard": [[{ "text", "url" }]] }`.' },
    },
    required: ['chat_id', 'text'],
  },
  {
    path: 'edit_message_text',
    method: 'editMessageText',
    verb: 'POST',
    name: 'Edit message',
    description: 'Replace the text of a message the bot sent. Requires `chat_id`, `message_id` and `text`.',
    risk: 'write',
    properties: {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: { type: 'integer', description: 'Id of the message to edit.' },
      text: { type: 'string', description: 'New text, 1-4096 characters.' },
      parse_mode: { type: 'string', description: 'Optional `HTML` or `MarkdownV2`.' },
    },
    required: ['chat_id', 'message_id', 'text'],
  },
  {
    path: 'delete_message',
    method: 'deleteMessage',
    verb: 'POST',
    name: 'Delete message',
    description: 'Delete a message the bot sent, less than 48 hours old.',
    risk: 'destructive',
    properties: {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: { type: 'integer', description: 'Id of the message to delete.' },
    },
    required: ['chat_id', 'message_id'],
  },
  {
    path: 'send_chat_action',
    method: 'sendChatAction',
    verb: 'POST',
    name: 'Show typing',
    description: 'Show "typing…" in a chat for about 5 seconds while you work on an answer.',
    risk: 'read',
    properties: {
      chat_id: TELEGRAM_CHAT_ID,
      action: { type: 'string', description: 'Use `typing`.' },
    },
    required: ['chat_id', 'action'],
    defaults: { action: 'typing' },
  },
  {
    path: 'get_chat',
    method: 'getChat',
    verb: 'POST',
    name: 'Get chat',
    description: 'Fetch a chat: its type, title or username.',
    risk: 'read',
    properties: { chat_id: TELEGRAM_CHAT_ID },
    required: ['chat_id'],
  },
  {
    path: 'get_me',
    method: 'getMe',
    verb: 'POST',
    name: 'Get bot',
    description: 'Fetch the bot itself: its id and username.',
    risk: 'read',
    properties: {},
    required: [],
  },
];

/** The fixed catalog for a channel platform (empty for an unknown platform). */
/**
 * Merge a Slack action's curated defaults under the caller's args. Read live at
 * call time, so it covers connectors materialized before a default existed.
 */
export function withChannelDefaults(
  platform: string,
  actionPath: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const actions = platform === 'slack' ? SLACK_ACTIONS : platform === 'telegram' ? TELEGRAM_ACTIONS : null;
  const defaults = actions?.find((a) => a.path === actionPath)?.defaults;
  return defaults ? { ...defaults, ...args } : args;
}

export function channelCatalog(platform: string): NormalizedAction[] {
  switch (platform) {
    case 'slack':
      return SLACK_ACTIONS.map(toAction);
    case 'teams':
      return TEAMS_ACTIONS.map(toAction);
    case 'email':
      return EMAIL_ACTIONS.map(toAction);
    case 'telegram':
      return TELEGRAM_ACTIONS.map(toAction);
    default:
      return [];
  }
}
