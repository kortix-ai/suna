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
 *
 * Voice is the one channel that breaks the "plain http binding" pattern: it
 * has no third-party API and no install token — a call is a LiveKit room
 * created by this API's own server-side code. Its actions bind `{ kind:
 * 'voice', op }` instead of `http`, and the gateway routes them through
 * GatewayDeps.executeVoiceCall rather than executeCall. It still goes through
 * the same connector row / catalog / policy / audit machinery as every other
 * channel — only the execution mechanism differs.
 */
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
export const VOICE_CHANNEL_CONNECTOR_SLUG = 'kortix_voice';

export function channelDefaultSlug(platform: string): string {
  switch (platform) {
    case 'slack':
      return SLACK_CHANNEL_CONNECTOR_SLUG;
    case 'teams':
      return TEAMS_CHANNEL_CONNECTOR_SLUG;
    case 'email':
      return EMAIL_CHANNEL_CONNECTOR_SLUG;
    case 'voice':
      return VOICE_CHANNEL_CONNECTOR_SLUG;
    default:
      return platform;
  }
}

/**
 * Per-platform credential placement. Slack/Teams/email all attach their
 * install token as `Authorization: Bearer <token>`. Voice has no install
 * token at all — a call is created by this API's own server-side code
 * (LiveKit config lives in this service's env, not a per-project install), so
 * the gateway never needs to resolve or attach a credential for it.
 */
export function channelAuth(platform: string): ConnectorAuth {
  if (platform === 'voice') return { type: 'none', in: 'header', name: null, prefix: null };
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
      return 'https://api.agentmail.to/v0';
    case 'voice':
      // No external API base — every voice action is a `{ kind: 'voice' }`
      // binding executed by the gateway's own server-side code, never HTTP.
      return '';
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
    case 'voice':
      return 'Voice';
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
      url: { type: 'string', description: 'URL from which AgentMail can fetch the file.' },
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
 *   • step / send(answer) — the turn-stream relay (dosco-internal, kept as-is).
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
      attachments: EMAIL_ATTACHMENT_SCHEMA,
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
      attachments: EMAIL_ATTACHMENT_SCHEMA,
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
      attachments: EMAIL_ATTACHMENT_SCHEMA,
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
 * One curated voice action — normalized into a `{ kind: 'voice' }`-bound
 * NormalizedAction. Unlike `ChannelActionDef` there is no HTTP method/path:
 * every voice action is executed by this API's own server-side code
 * (GatewayDeps.executeVoiceCall), never an outbound request, so there is
 * nothing for executeCall's HTTP builders to do here.
 */
interface VoiceActionDef {
  /** Connector-relative tool path — also the `op` the binding carries. */
  path: string;
  name: string;
  description: string;
  risk: Risk;
  /** `enum` is carried through to the JSON Schema so a closed set of modes is
   *  discoverable from the schema instead of only from prose in the
   *  description — the model sees both, and only one of them is machine-checked. */
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
}

/**
 * The Voice catalog — THE KORTIX AGENT'S side of a live call.
 *
 * Two surfaces exist and they point in opposite directions; keep them straight:
 *   - THIS connector is how the dosco agent drives a call from the inside:
 *     start one, read what is being said, say something, hang up.
 *   - The voice MCP (channels/voice/mcp.ts) is the other direction — how the
 *     LiveKit voice agent calls BACK into dosco from the outside.
 *
 * These actions live on the connector rather than in a project's opencode
 * config on purpose: connectors are materialized server-side for every project,
 * so an existing project gets them the moment this ships. Config shipped in the
 * starter template only ever reaches projects created AFTER the change, which
 * silently left every older project unable to talk to its own calls.
 *
 * `spawn_room` is the one implemented joining mechanism. `join_gmeet` /
 * `join_zoom` are declared so the surface is stable and future mechanisms slot
 * in without reshaping the catalog, but neither is implemented: calling either
 * fails with a clear, actionable error — never silently absent, never
 * pretending to work. See GatewayDeps.executeVoiceCall in gateway.ts/db-deps.ts.
 */
const VOICE_ACTIONS: VoiceActionDef[] = [
  {
    path: 'spawn_room',
    name: 'Spawn voice room',
    description:
      'Create a live voice room bound to this session and return a join link — a human opens it in their own browser to talk with you. The only voice mechanism implemented today.',
    risk: 'write',
    properties: {
      voice: { type: 'string', description: 'Optional speaking voice for the agent side of the call.' },
    },
    required: [],
  },
  {
    path: 'read_transcript',
    name: 'Read call transcript',
    // The description is re-read by the model on every single turn, so it is
    // written to make the DEFAULT unmissable in the first sentence and the modes
    // findable in the last. The old wording led with `cursor`, which taught the
    // agent that following a call meant carrying a number between turns — the
    // exact habit that made it pass 0 and re-read whole conversations.
    description:
      'Read what is being said in the live call — both sides. Call it BARE, with no arguments: you get only what you have not already been shown, because your read position is remembered per call. You never track a cursor and never re-read the same turns. Returns IMMEDIATELY, empty when nothing is new — it never waits for anyone to speak. Every reply carries `unread` (turns still waiting after this one) and `live`. Other modes: `last` = the newest few turns whatever you have read, for re-orienting mid-call; `full` = the entire call; or pass an explicit `cursor` to page it yourself. Only `unread` and `full` move your saved position; add `peek: true` to read the unread without consuming it.',
    // Still 'read', even though the default advances a saved read position. What
    // it mutates is bookkeeping about the READER — nothing about the call, the
    // room or the transcript changes, no other reader observes it, and every
    // turn stays readable via `last`/`full`/`cursor`. Grading it 'write' would
    // put the agent's cheapest and most-encouraged action behind approval in
    // stricter policy modes. `peek: true` is the literally-non-mutating read.
    // Full reasoning: channels/voice/transcript-read.ts.
    risk: 'read',
    properties: {
      mode: {
        type: 'string',
        enum: ['unread', 'last', 'full', 'cursor'],
        description:
          'Default `unread`: only turns you have not been shown. `last`: the most recent `limit` turns regardless of what you have read. `full`: the whole call. `cursor`: everything after the `cursor` you pass.',
      },
      limit: {
        type: 'number',
        description: 'Max turns to return. Defaults: unread 100, last 10, full 500. Capped at 500.',
      },
      peek: {
        type: 'boolean',
        description:
          'Read without advancing your saved position, so the same turns come back next time. Use it when you may not get to act on them.',
      },
      cursor: {
        type: 'number',
        description:
          'Return only turns after this cursor, and leave your saved position alone. Implies `mode: cursor`. Only needed if you are keeping your own place.',
      },
    },
    required: [],
  },
  {
    path: 'send_prompt',
    name: 'Say something in the call',
    description:
      'Speak into the live call in your own voice, without waiting to be asked. Use it to answer what someone wanted, volunteer something you found, or say you need a moment. Plain spoken language only — no markdown, no URLs, no code. Returns immediately.',
    risk: 'write',
    properties: {
      text: {
        type: 'string',
        description: 'What to say, in plain spoken language.',
      },
    },
    required: ['text'],
  },
  {
    path: 'end_call',
    name: 'End the call',
    description: 'Hang up the live call for this session and tear down its room.',
    risk: 'write',
    properties: {},
    required: [],
  },
  {
    path: 'join_gmeet',
    name: 'Join Google Meet',
    description:
      'NOT IMPLEMENTED YET. Joining an existing Google Meet is not supported — use spawn_room instead and share the join link with whoever you would have invited.',
    risk: 'write',
    properties: {
      meeting_url: {
        type: 'string',
        description: 'The Google Meet URL you would join (accepted for forward compatibility; not usable yet).',
      },
    },
    required: ['meeting_url'],
  },
  {
    path: 'join_zoom',
    name: 'Join Zoom',
    description:
      'NOT IMPLEMENTED YET. Joining an existing Zoom meeting is not supported — use spawn_room instead and share the join link with whoever you would have invited.',
    risk: 'write',
    properties: {
      meeting_url: {
        type: 'string',
        description: 'The Zoom meeting URL you would join (accepted for forward compatibility; not usable yet).',
      },
    },
    required: ['meeting_url'],
  },
];

function toVoiceAction(def: VoiceActionDef): NormalizedAction {
  const binding: ActionBinding = { kind: 'voice', op: def.path };
  const inputSchema = Object.keys(def.properties).length
    ? {
        type: 'object',
        properties: def.properties,
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
    case 'voice':
      return VOICE_ACTIONS.map(toVoiceAction);
    default:
      return [];
  }
}
