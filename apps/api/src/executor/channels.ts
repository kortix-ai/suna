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
import type { ActionBinding, NormalizedAction, Risk } from './types';

// `ChannelPlatform` + the platform allow-list are owned by projects/connectors.ts
// (the parser layer the executor builds on). This module just maps a platform
// string → its catalog / API base, so it takes plain strings and returns []/''
// for anything it doesn't know.

/** Per-platform API base — the connector's baseUrl, where http bindings resolve. */
export function channelApiBase(platform: string): string {
  switch (platform) {
    case 'slack':
      return 'https://slack.com/api';
    default:
      return '';
  }
}

/** Human label for a channel connector (UI default name). */
export function channelLabel(platform: string): string {
  switch (platform) {
    case 'slack':
      return 'Slack';
    default:
      return platform;
  }
}

/** One curated channel action — normalized into an http-bound NormalizedAction. */
interface ChannelActionDef {
  /** Connector-relative tool path (the executor namespace tail, e.g. `send_message`). */
  path: string;
  /** Slack Web API method name (the URL tail under https://slack.com/api/<method>). */
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
    description: 'Post a message to a Slack channel or thread. Provide `channel` plus `text` and/or Block Kit `blocks`; set `thread_ts` to reply in a thread.',
    risk: 'write',
    properties: {
      channel: { type: 'string', description: 'Channel ID (e.g. C0123) or user ID for a DM.' },
      text: { type: 'string', description: 'Message text (mrkdwn). Also used as the notification fallback when sending blocks.' },
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
    description: 'Add an emoji reaction to a message. Requires `channel`, the message `timestamp`, and the emoji `name` (without colons).',
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
    description: 'Fetch recent messages from a channel. Provide `channel`; optional `limit` (default 20).',
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
    description: 'Fetch the replies in a thread. Requires `channel` and the thread root `ts`; optional `limit`.',
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
    description: 'List public + private channels the bot can see (excludes archived). Optional `limit`.',
    risk: 'read',
    properties: {
      limit: { type: 'number', description: 'Max channels to return (default 100).' },
      types: { type: 'string', description: 'Comma-separated channel types (default "public_channel,private_channel").' },
      exclude_archived: { type: 'boolean', description: 'Exclude archived channels (default true).' },
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
    description: 'Return the authenticated bot identity (user_id, team, bot_id) — the "who am I" call.',
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

function toAction(def: ChannelActionDef): NormalizedAction {
  const binding: ActionBinding = { kind: 'http', method: def.verb, path: `/${def.method}` };
  const inputSchema = Object.keys(def.properties).length
    ? { type: 'object', properties: def.properties, ...(def.required.length ? { required: def.required } : {}) }
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

/** The fixed catalog for a channel platform (empty for an unknown platform). */
export function channelCatalog(platform: string): NormalizedAction[] {
  switch (platform) {
    case 'slack':
      return SLACK_ACTIONS.map(toAction);
    default:
      return [];
  }
}
