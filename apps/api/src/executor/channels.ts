/**
 * Channel connectors — chat platforms (Slack today; Telegram/Teams next) as
 * first-class Executor connectors. Unlike the spec-driven providers, a channel's
 * catalog is a FIXED, hand-curated set of actions (the platform's stable API
 * surface), and its credential is the platform's existing install token,
 * resolved server-side from the install-store (no executor_credentials row, no
 * data migration). Each action is a plain `http` binding against the platform's
 * API base, so the gateway's existing executeCall runs them unchanged. The
 * Slack catalog mirrors the in-sandbox `slack` CLI 1:1 for full parity. See
 * KORTIX-206.
 */
import { config } from '../config';
import type { ExecutorAuth } from './execute';
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
export const MEET_CHANNEL_CONNECTOR_SLUG = 'kortix_meet';

export function channelDefaultSlug(platform: string): string {
  switch (platform) {
    case 'slack':
      return SLACK_CHANNEL_CONNECTOR_SLUG;
    case 'teams':
      return TEAMS_CHANNEL_CONNECTOR_SLUG;
    case 'email':
      return EMAIL_CHANNEL_CONNECTOR_SLUG;
    case 'meet':
      return MEET_CHANNEL_CONNECTOR_SLUG;
    default:
      return platform;
  }
}

/**
 * Per-platform credential placement. Slack/email attach their install token as
 * `Authorization: Bearer <token>`; Recall.ai (meet) wants `Authorization: Token
 * <key>`. executeCall's applyAuth honors the custom `name`+`prefix` verbatim, so
 * the only meet-specific auth wiring is this descriptor.
 */
export function channelAuth(platform: string): ExecutorAuth {
  if (platform === 'meet') return { type: 'custom', in: 'header', name: 'Authorization', prefix: 'Token ' };
  return { type: 'bearer', in: 'header', name: null, prefix: null };
}

// `ChannelPlatform` + the platform allow-list are owned by projects/connectors.ts
// (the parser layer the executor builds on). This module just maps a platform
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
      return 'https://api.agentmail.to/v0';
    case 'meet':
      // Recall.ai regional gateway. Swappable via RECALL_BASE_URL.
      return config.RECALL_BASE_URL;
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
    case 'meet':
      return 'Google Meet';
    default:
      return platform;
  }
}

/** One curated channel action — normalized into an http-bound NormalizedAction. */
interface ChannelActionDef {
  /** Connector-relative tool path (the executor namespace tail, e.g. `send_message`). */
  path: string;
  /** Platform API path/method tail. */
  method: string;
  /** HTTP verb — POST methods send a JSON body; GET methods send a query string. */
  verb: 'GET' | 'POST';
  name: string;
  description: string;
  risk: Risk;
  /** JSON-schema properties using Slack's NATIVE param names (passed through verbatim). */
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

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
      'Post a message to a Slack channel or thread. Provide `channel` plus `text` and/or Block Kit `blocks`; set `thread_ts` to reply in a thread.',
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
      limit: { type: 'number', description: 'Max replies to return (default 20).' },
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
      limit: { type: 'number', description: 'Max users to return (default 100).' },
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

const EMAIL_ACTIONS: ChannelActionDef[] = [
  {
    path: 'send_message',
    method: 'inboxes/{inbox_id}/messages/send',
    verb: 'POST',
    name: 'Send email',
    description: 'Send a new email from an AgentMail inbox. Supports text/html and attachments.',
    risk: 'write',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID to send from.' },
      to: { type: 'array', description: 'Recipient email address or addresses.' },
      cc: { type: 'array', description: 'Optional CC recipients.' },
      bcc: { type: 'array', description: 'Optional BCC recipients.' },
      subject: { type: 'string', description: 'Email subject.' },
      text: { type: 'string', description: 'Plain text body.' },
      html: { type: 'string', description: 'HTML body.' },
      attachments: { type: 'array', description: 'Optional AgentMail send attachments.' },
    },
    required: ['to'],
  },
  {
    path: 'reply_message',
    method: 'inboxes/{inbox_id}/messages/{message_id}/reply',
    verb: 'POST',
    name: 'Reply to email',
    description: 'Reply in the same AgentMail thread as an existing message.',
    risk: 'write',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      message_id: { type: 'string', description: 'Message ID to reply to.' },
      reply_all: { type: 'boolean', description: 'Reply to all recipients of the original message.' },
      to: { type: 'array', description: 'Optional override recipients.' },
      cc: { type: 'array', description: 'Optional CC recipients.' },
      bcc: { type: 'array', description: 'Optional BCC recipients.' },
      text: { type: 'string', description: 'Plain text body.' },
      html: { type: 'string', description: 'HTML body.' },
      attachments: { type: 'array', description: 'Optional AgentMail send attachments.' },
    },
    required: ['message_id'],
  },
  {
    path: 'reply_all_message',
    method: 'inboxes/{inbox_id}/messages/{message_id}/reply-all',
    verb: 'POST',
    name: 'Reply all to email',
    description: 'Reply-all in the same AgentMail thread as an existing message.',
    risk: 'write',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      message_id: { type: 'string', description: 'Message ID to reply-all to.' },
      text: { type: 'string', description: 'Plain text body.' },
      html: { type: 'string', description: 'HTML body.' },
      attachments: { type: 'array', description: 'Optional AgentMail send attachments.' },
    },
    required: ['message_id'],
  },
  {
    path: 'list_messages',
    method: 'inboxes/{inbox_id}/messages',
    verb: 'GET',
    name: 'List inbox messages',
    description: 'List messages in an AgentMail inbox.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      limit: { type: 'number', description: 'Maximum messages to return.' },
    },
    required: [],
  },
  {
    path: 'get_message',
    method: 'inboxes/{inbox_id}/messages/{message_id}',
    verb: 'GET',
    name: 'Get email message',
    description: 'Fetch a single AgentMail message.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      message_id: { type: 'string', description: 'AgentMail message ID.' },
    },
    required: ['message_id'],
  },
  {
    path: 'search_messages',
    method: 'inboxes/{inbox_id}/messages/search',
    verb: 'GET',
    name: 'Search inbox messages',
    description: 'Search messages in an AgentMail inbox.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'number', description: 'Maximum messages to return.' },
    },
    required: ['query'],
  },
  {
    path: 'list_threads',
    method: 'inboxes/{inbox_id}/threads',
    verb: 'GET',
    name: 'List email threads',
    description: 'List threads in an AgentMail inbox.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      limit: { type: 'number', description: 'Maximum threads to return.' },
    },
    required: [],
  },
  {
    path: 'get_thread',
    method: 'inboxes/{inbox_id}/threads/{thread_id}',
    verb: 'GET',
    name: 'Get email thread',
    description: 'Fetch an AgentMail thread and its message context.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      thread_id: { type: 'string', description: 'AgentMail thread ID.' },
    },
    required: ['thread_id'],
  },
  {
    path: 'get_message_attachment',
    method: 'inboxes/{inbox_id}/messages/{message_id}/attachments/{attachment_id}',
    verb: 'GET',
    name: 'Get email attachment',
    description: 'Download an attachment from an AgentMail message.',
    risk: 'read',
    properties: {
      inbox_id: { type: 'string', description: 'AgentMail inbox ID.' },
      message_id: { type: 'string', description: 'AgentMail message ID.' },
      attachment_id: { type: 'string', description: 'AgentMail attachment ID.' },
    },
    required: ['message_id', 'attachment_id'],
  },
];

/**
 * The Recall.ai (Google Meet/Teams/Zoom) catalog — the meeting-bot lifecycle +
 * transcript reads. Property names match Recall's REST API exactly. Recall is
 * bot-id-centric: `join_meeting` takes the full `meeting_url` and returns a bot
 * `id`; everything else keys off that `id` (a path param). Trailing slashes are
 * required (Recall runs Django REST Framework). Phase 1 is listen-only — speak /
 * output-media land in Phase 2.
 */
const MEET_ACTIONS: ChannelActionDef[] = [
  {
    path: 'join_meeting',
    method: 'bot/',
    verb: 'POST',
    name: 'Join meeting',
    description:
      'Send the notetaker bot to join a meeting and start recording/transcribing. Provide the full `meeting_url`; returns a bot with an `id` used for the other actions.',
    risk: 'write',
    properties: {
      meeting_url: { type: 'string', description: 'Full meeting URL, e.g. https://meet.google.com/abc-defg-hij.' },
      bot_name: { type: 'string', description: 'Display name the bot joins under (announces it is recording).' },
      recording_config: {
        type: 'object',
        description: 'Recall recording config. Set transcript.provider (e.g. meeting_captions) to enable a transcript.',
      },
    },
    required: ['meeting_url'],
  },
  {
    path: 'leave_meeting',
    method: 'bot/{id}/leave_call/',
    verb: 'POST',
    name: 'Leave meeting',
    description: 'Remove the bot from the meeting (irreversible). Requires the bot `id`.',
    risk: 'write',
    properties: {
      id: { type: 'string', description: 'The bot id returned by join_meeting.' },
    },
    required: ['id'],
  },
  {
    path: 'send_chat_message',
    method: 'bot/{id}/send_chat_message/',
    verb: 'POST',
    name: 'Send chat message',
    description:
      "Post a message to the meeting chat as the bot. Requires the bot `id` and `message` text (1–4096 chars). This is how the agent talks back in the call.",
    risk: 'write',
    properties: {
      id: { type: 'string', description: 'The bot id returned by join_meeting.' },
      message: { type: 'string', description: 'Chat message text (1–4096 characters).' },
      to: { type: 'string', description: 'Optional recipient (defaults to everyone).' },
      pin: { type: 'boolean', description: 'Optional — pin the message.' },
    },
    required: ['id', 'message'],
  },
  {
    path: 'bot_status',
    method: 'bot/{id}/',
    verb: 'GET',
    name: 'Bot status',
    description: 'Retrieve a bot — its current status (joining / in_call / done) and recordings. Requires the bot `id`.',
    risk: 'read',
    properties: {
      id: { type: 'string', description: 'The bot id returned by join_meeting.' },
    },
    required: ['id'],
  },
  {
    path: 'get_transcript',
    method: 'transcript/',
    verb: 'GET',
    name: 'Get transcript',
    description:
      "List the bot's transcript artifact(s). Requires `bot_id`. Each result has a status and, once processing completes, `data.download_url` — a presigned URL to the transcript JSON (words + speaker). The bot must have been created with recording_config.transcript.provider set.",
    risk: 'read',
    properties: {
      bot_id: { type: 'string', description: 'The bot id returned by join_meeting.' },
    },
    required: ['bot_id'],
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
    description: 'List recent messages in a channel (history). Requires `team-id` and `channel-id`.',
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
    description: 'List replies to a channel message (a thread). Requires `team-id`, `channel-id`, `message-id`.',
    risk: 'read',
    properties: {
      'team-id': { type: 'string', description: 'The team (group) id.' },
      'channel-id': { type: 'string', description: 'The channel id.' },
      'message-id': { type: 'string', description: 'The message id.' },
    },
    required: ['team-id', 'channel-id', 'message-id'],
  },
];

/** The fixed catalog for a channel platform (empty for an unknown platform). */
export function channelCatalog(platform: string): NormalizedAction[] {
  switch (platform) {
    case 'slack':
      return SLACK_ACTIONS.map(toAction);
    case 'teams':
      return TEAMS_ACTIONS.map(toAction);
    case 'email':
      return EMAIL_ACTIONS.map(toAction);
    case 'meet':
      return MEET_ACTIONS.map(toAction);
    default:
      return [];
  }
}
