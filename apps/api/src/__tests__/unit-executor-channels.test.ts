/**
 * Channel connectors (Slack + Email as first-class Executor connectors).
 *   • catalog — fixed channel action sets normalize to http bindings against
 *     provider APIs, with native param names + correct verbs/risks.
 *   • parse   — `provider="channel" platform="..."` round-trips; bad platform
 *     and a declared auth table are rejected.
 *   • gateway — channel calls build the right provider request with the install
 *     token as a bearer, and Slack's HTTP-200 `{ok:false}` envelope is surfaced
 *     as a real error (parity with the in-sandbox CLI's throw).
 */
import { describe, expect, test } from 'bun:test';
import {
  EMAIL_CHANNEL_CONNECTOR_SLUG,
  SLACK_CHANNEL_CONNECTOR_SLUG,
  VOICE_CHANNEL_CONNECTOR_SLUG,
  channelApiBase,
  channelAuth,
  channelCatalog,
  channelDefaultSlug,
} from '../executor/channels';
import {
  type CallInput,
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
  handleCall,
} from '../executor/gateway';
import type { NormalizedAction } from '../executor/types';
import { connectorSpecToTomlEntry, extractConnectors } from '../projects/connectors';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value == null) throw new Error('expected value to be defined');
  return value;
}

function objectSchema(schema: NormalizedAction['inputSchema']): {
  properties: Record<string, unknown>;
  required?: string[];
} {
  expect(schema).toBeTruthy();
  return schema as { properties: Record<string, unknown>; required?: string[] };
}

/* ─── catalog ─────────────────────────────────────────────────────────────── */

describe('channelCatalog(slack)', () => {
  const actions = channelCatalog('slack');
  const byPath = new Map(actions.map((a) => [a.path, a]));
  const action = (path: string) => expectDefined(byPath.get(path));

  test('exposes the full native Slack surface as http bindings', () => {
    // 14 native Web API methods (relay/typing/download/manifest/file-upload are CLI-side).
    expect(actions.length).toBe(14);
    for (const a of actions) {
      expect(a.binding.kind).toBe('http');
      if (a.binding.kind === 'http') expect(a.binding.path.startsWith('/')).toBe(true);
    }
  });

  test('send_message → POST /chat.postMessage, write, channel required', () => {
    const a = action('send_message');
    expect(a.binding).toEqual({ kind: 'http', method: 'POST', path: '/chat.postMessage' });
    expect(a.risk).toBe('write');
    expect(objectSchema(a.inputSchema).required).toContain('channel');
  });

  test('get_history → GET /conversations.history, read', () => {
    const a = action('get_history');
    expect(a.binding).toEqual({ kind: 'http', method: 'GET', path: '/conversations.history' });
    expect(a.risk).toBe('read');
  });

  test('delete_message is destructive; reactions use Slack native param names', () => {
    expect(action('delete_message').risk).toBe('destructive');
    const react = action('add_reaction');
    const props = Object.keys(objectSchema(react.inputSchema).properties);
    expect(props).toEqual(['channel', 'timestamp', 'name']); // not ts/emoji — Slack's own names
  });

  test('auth_test has no inputs; unknown platform → empty', () => {
    expect(action('auth_test').inputSchema).toBeNull();
    expect(channelCatalog('nope')).toEqual([]);
  });

  test('api base', () => {
    expect(channelApiBase('slack')).toBe('https://slack.com/api');
  });

  test('default slack channel slug is platform-owned, not the user connector namespace', () => {
    expect(channelDefaultSlug('slack')).toBe(SLACK_CHANNEL_CONNECTOR_SLUG);
    expect(SLACK_CHANNEL_CONNECTOR_SLUG).toBe('kortix_slack');
  });
});

describe('channelCatalog(email)', () => {
  const actions = channelCatalog('email');
  const byPath = new Map(actions.map((a) => [a.path, a]));
  const action = (path: string) => expectDefined(byPath.get(path));

  test('exposes the AgentMail inbox/thread surface as http bindings', () => {
    expect(actions.map((a) => a.path).sort()).toEqual([
      'get_message',
      'get_message_attachment',
      'get_thread',
      'list_messages',
      'list_threads',
      'reply_all_message',
      'reply_message',
      'search_messages',
      'send_message',
    ]);
    for (const a of actions) {
      expect(a.binding.kind).toBe('http');
      if (a.binding.kind === 'http') expect(a.binding.path.startsWith('/')).toBe(true);
    }
  });

  test('reply_message path params are marked for URL substitution', () => {
    const a = action('reply_message');
    expect(a.binding).toEqual({
      kind: 'http',
      method: 'POST',
      path: '/inboxes/{inbox_id}/messages/{message_id}/reply',
    });
    const props = objectSchema(a.inputSchema).properties as Record<string, any>;
    expect(props.inbox_id['x-in']).toBe('path');
    expect(props.message_id['x-in']).toBe('path');
    expect(a.risk).toBe('write');
  });

  test('profile-scoped actions do not require agents to supply inbox_id', () => {
    expect(objectSchema(action('list_messages').inputSchema).required ?? []).not.toContain(
      'inbox_id',
    );
    expect(objectSchema(action('list_threads').inputSchema).required ?? []).not.toContain(
      'inbox_id',
    );
    expect(objectSchema(action('send_message').inputSchema).required ?? []).toEqual(['to']);
    expect(objectSchema(action('reply_message').inputSchema).required ?? []).toEqual([
      'message_id',
    ]);
  });

  test('api base + default slug', () => {
    expect(channelApiBase('email')).toBe('https://api.agentmail.to/v0');
    expect(channelDefaultSlug('email')).toBe(EMAIL_CHANNEL_CONNECTOR_SLUG);
    expect(EMAIL_CHANNEL_CONNECTOR_SLUG).toBe('kortix_email');
  });
});

describe('channelCatalog(voice)', () => {
  const actions = channelCatalog('voice');
  const byPath = new Map(actions.map((a) => [a.path, a]));
  const action = (path: string) => expectDefined(byPath.get(path));

  test('exposes the full both-directions surface, not just spawning', () => {
    // The Kortix agent drives a call from the INSIDE through this connector, so
    // spawning alone is useless: it also has to hear the room (read_transcript)
    // and answer it (send_prompt). Those two living somewhere else is exactly
    // how an agent ended up able to start a call it could not then talk to.
    expect(actions.map((a) => a.path).sort()).toEqual([
      'end_call',
      'join_gmeet',
      'join_zoom',
      'read_transcript',
      'send_prompt',
      'spawn_room',
    ]);
  });

  test('read_transcript takes NOTHING by default — that is the whole point', () => {
    // The default has to be both cheap and correct with zero arguments: the
    // read position lives on the server (channels/voice/transcript-read.ts), so
    // an agent that remembers nothing still never re-reads the same turns. The
    // moment anything here becomes required, the agent is carrying state again.
    const a = action('read_transcript');
    expect(objectSchema(a.inputSchema).required ?? []).toEqual([]);
    expect(Object.keys(objectSchema(a.inputSchema).properties).sort()).toEqual([
      'cursor',
      'limit',
      'mode',
      'peek',
    ]);
  });

  test('the modes are a closed, schema-declared set — not prose the model has to infer', () => {
    const mode = objectSchema(action('read_transcript').inputSchema).properties.mode as {
      enum?: string[];
    };
    expect(mode.enum).toEqual(['unread', 'last', 'full', 'cursor']);
  });

  test('read_transcript stays a READ even though the default advances a read position', () => {
    // It mutates only bookkeeping about the READER — nothing about the call —
    // and it is the action the agent is told to run at the top of every turn.
    // Grading it 'write' would put that behind approval in stricter policy
    // modes. `peek: true` is the non-mutating escape hatch.
    const a = action('read_transcript');
    expect(a.risk).toBe('read');
    expect(Object.keys(objectSchema(a.inputSchema).properties)).toContain('peek');
  });

  test('the description leads with the bare call and never blocks', () => {
    // This string is re-read by the model on every turn. The old wording led
    // with `cursor`, which taught the agent to carry a number between turns —
    // and an agent that dropped it passed 0 and re-read the entire call.
    const d = action('read_transcript').description;
    expect(d).toContain('BARE');
    expect(d).toMatch(/IMMEDIATELY/);
    expect(d).toContain('never waits');
    expect(d.indexOf('BARE')).toBeLessThan(d.indexOf('cursor'));
  });

  test('send_prompt requires the text to speak', () => {
    const a = action('send_prompt');
    expect(a.risk).toBe('write');
    expect(objectSchema(a.inputSchema).required ?? []).toEqual(['text']);
  });

  test('every voice action binds `{ kind: "voice" }`, never http — there is no third-party API', () => {
    for (const a of actions) {
      expect(a.binding.kind).toBe('voice');
      if (a.binding.kind === 'voice') expect(a.binding.op).toBe(a.path);
    }
  });

  test('spawn_room takes an optional voice, no meeting_url', () => {
    const a = action('spawn_room');
    expect(a.risk).toBe('write');
    const props = objectSchema(a.inputSchema).properties;
    expect(Object.keys(props)).toEqual(['voice']);
    expect(objectSchema(a.inputSchema).required ?? []).toEqual([]);
  });

  test('join_gmeet / join_zoom are declared with a meeting_url input and read as not-implemented', () => {
    for (const path of ['join_gmeet', 'join_zoom']) {
      const a = action(path);
      expect(objectSchema(a.inputSchema).required).toEqual(['meeting_url']);
      expect(a.description).toMatch(/not implemented/i);
      expect(a.description).toMatch(/spawn_room/);
    }
  });

  test('no credential, no external API base — a call is created by this API itself', () => {
    expect(channelAuth('voice')).toEqual({ type: 'none', in: 'header', name: null, prefix: null });
    expect(channelApiBase('voice')).toBe('');
  });

  test('reserved voice channel slug', () => {
    expect(channelDefaultSlug('voice')).toBe(VOICE_CHANNEL_CONNECTOR_SLUG);
    expect(VOICE_CHANNEL_CONNECTOR_SLUG).toBe('kortix_voice');
  });
});

/* ─── parse ───────────────────────────────────────────────────────────────── */

function parse(body: string) {
  const src = [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, '\n[project]\nname = "t"\n', body].join(
    '\n',
  );
  return extractConnectors(parseManifestString(src));
}

describe('[[connectors]] provider="channel"', () => {
  test('slack platform parses + round-trips through TOML', () => {
    const { specs, errors } = parse(`
[[connectors]]
slug = "slack"
provider = "channel"
platform = "slack"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ slug: 'slack', provider: 'channel', platform: 'slack' });
    expect(connectorSpecToTomlEntry(expectDefined(specs[0]))).toMatchObject({
      provider: 'channel',
      platform: 'slack',
    });
  });

  test('email platform parses + round-trips through TOML', () => {
    const { specs, errors } = parse(`
[[connectors]]
slug = "kortix_email"
provider = "channel"
platform = "email"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'kortix_email',
      provider: 'channel',
      platform: 'email',
    });
    expect(connectorSpecToTomlEntry(expectDefined(specs[0]))).toMatchObject({
      provider: 'channel',
      platform: 'email',
    });
  });

  test('missing / unknown platform is rejected', () => {
    expect(
      expectDefined(
        parse(`
[[connectors]]
slug = "x"
provider = "channel"
`).errors[0],
      ).error,
    ).toMatch(/platform/);
    expect(
      expectDefined(
        parse(`
[[connectors]]
slug = "x"
provider = "channel"
platform = "discord"
`).errors[0],
      ).error,
    ).toMatch(/platform/);
  });

  test('declaring [connectors.auth] is rejected (credential is the install token)', () => {
    const { errors } = parse(`
[[connectors]]
slug = "slack"
provider = "channel"
platform = "slack"

  [connectors.auth]
  type = "bearer"
`);
    expect(expectDefined(errors[0]).error).toMatch(/install token/);
  });
});

/* ─── gateway execution ───────────────────────────────────────────────────── */

const SLACK: GatewayConnector = {
  connectorId: 'conn-slack',
  slug: SLACK_CHANNEL_CONNECTOR_SLUG,
  provider: 'channel',
  baseUrl: 'https://slack.com/api',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const EMAIL: GatewayConnector = {
  connectorId: 'conn-email',
  slug: EMAIL_CHANNEL_CONNECTOR_SLUG,
  provider: 'channel',
  platform: 'email',
  baseUrl: 'https://api.agentmail.to/v0',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const SEND: GatewayAction = {
  path: 'slack.send_message',
  relPath: 'send_message',
  inputSchema: { type: 'object', properties: { channel: {}, text: {} }, required: ['channel'] },
  risk: 'write',
  binding: { kind: 'http', method: 'POST', path: '/chat.postMessage' },
};

const EMAIL_REPLY: GatewayAction = {
  path: 'email.reply_message',
  relPath: 'reply_message',
  inputSchema: {
    type: 'object',
    properties: {
      inbox_id: { 'x-in': 'path' },
      message_id: { 'x-in': 'path' },
      text: {},
    },
    required: ['inbox_id', 'message_id'],
  },
  risk: 'write',
  binding: {
    kind: 'http',
    method: 'POST',
    path: '/inboxes/{inbox_id}/messages/{message_id}/reply',
  },
};

const EMAIL_LIST_MESSAGES: GatewayAction = {
  path: 'email.list_messages',
  relPath: 'list_messages',
  inputSchema: {
    type: 'object',
    properties: {
      inbox_id: { 'x-in': 'path' },
      limit: {},
    },
  },
  risk: 'read',
  binding: { kind: 'http', method: 'GET', path: '/inboxes/{inbox_id}/messages' },
};

function makeDeps(body: string, status = 200) {
  const fetchCalls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => SLACK,
    loadAction: async () => SEND,
    resolveCredential: async () => 'xoxb-install-token',
    loadPolicies: async () => [],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    recordExecution: async () => null,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, ...init });
      return { status, ok: status >= 200 && status < 300, text: async () => body };
    },
  };
  return { deps, fetchCalls };
}

const input: CallInput = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  subject: { userId: 'u1', groupIds: [] },
  sessionId: 'sess-1',
  connectorSlug: 'slack',
  actionPath: 'send_message',
  args: { channel: 'C123', text: 'hi' },
};

describe('handleCall — channel (slack)', () => {
  test('builds the slack.com/api request, attaches the install token as bearer', async () => {
    const { deps, fetchCalls } = makeDeps('{"ok":true,"ts":"123.45","channel":"C123"}');
    const res = await handleCall(deps, input);
    expect(res.status).toBe('ok');
    const call = expectDefined(fetchCalls[0]);
    expect(call.url).toBe('https://slack.com/api/chat.postMessage');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer xoxb-install-token');
    expect(JSON.parse(expectDefined(call.body))).toEqual({ channel: 'C123', text: 'hi' });
  });

  test('Slack {ok:false} (HTTP 200) is surfaced as an error, not a silent ok', async () => {
    const { deps } = makeDeps('{"ok":false,"error":"channel_not_found"}');
    const res = await handleCall(deps, input);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toMatch(/channel_not_found/);
  });

  test('legacy connector="slack" calls use the reserved channel connector before a user-defined slack connector', async () => {
    const pipedreamSlack: GatewayConnector = {
      connectorId: 'conn-user-pipedream-slack',
      slug: 'slack',
      provider: 'pipedream',
      baseUrl: null,
      auth: { type: 'none', in: 'header', name: null, prefix: null },
      hasAuth: true,
      credentialMode: 'shared',
      enabled: true,
    };
    const getThread: GatewayAction = {
      path: `${SLACK_CHANNEL_CONNECTOR_SLUG}.get_thread`,
      relPath: 'get_thread',
      inputSchema: {
        type: 'object',
        properties: { channel: {}, ts: {} },
        required: ['channel', 'ts'],
      },
      risk: 'read',
      binding: { kind: 'http', method: 'GET', path: '/conversations.replies' },
    };
    const fetchCalls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const deps: GatewayDeps = {
      loadConnectorBySlug: async (_projectId, slug) => {
        if (slug === SLACK_CHANNEL_CONNECTOR_SLUG) return SLACK;
        if (slug === 'slack') return pipedreamSlack;
        return null;
      },
      loadAction: async (connectorId, relPath) =>
        connectorId === SLACK.connectorId && relPath === 'get_thread' ? getThread : null,
      resolveCredential: async (connector) =>
        connector.provider === 'channel' ? 'xoxb-install-token' : 'pipedream-account-id',
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, ...init });
        return { status: 200, ok: true, text: async () => '{"ok":true,"messages":[]}' };
      },
    };

    const res = await handleCall(deps, {
      ...input,
      connectorSlug: 'slack',
      actionPath: 'get_thread',
      args: { channel: 'C123', ts: '111.222' },
    });

    expect(res.status).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
    const [call] = fetchCalls;
    expect(call?.url).toBe('https://slack.com/api/conversations.replies?channel=C123&ts=111.222');
    expect(call?.headers.Authorization).toBe('Bearer xoxb-install-token');
  });
});

describe('handleCall — channel (email)', () => {
  test('legacy connector="email" calls use kortix_email and build AgentMail requests', async () => {
    const fetchCalls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const deps: GatewayDeps = {
      loadConnectorBySlug: async (_projectId, slug) =>
        slug === EMAIL_CHANNEL_CONNECTOR_SLUG ? EMAIL : null,
      loadAction: async (connectorId, relPath) =>
        connectorId === EMAIL.connectorId && relPath === 'reply_message' ? EMAIL_REPLY : null,
      resolveCredential: async () => 'am_project_token',
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, ...init });
        return { status: 200, ok: true, text: async () => '{"message_id":"msg-reply"}' };
      },
    };

    const res = await handleCall(deps, {
      ...input,
      connectorSlug: 'email',
      actionPath: 'reply_message',
      args: { inbox_id: 'inb_1', message_id: 'msg_1', text: 'Thanks' },
    });

    expect(res.status).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
    const call = expectDefined(fetchCalls[0]);
    expect(call.url).toBe('https://api.agentmail.to/v0/inboxes/inb_1/messages/msg_1/reply');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer am_project_token');
    expect(JSON.parse(expectDefined(call.body))).toEqual({ text: 'Thanks' });
  });

  test('email-originated sessions pin profile-specific calls to the active AgentMail inbox', async () => {
    const staleProfileConnector: GatewayConnector = {
      ...EMAIL,
      connectorId: 'conn-email-stale-profile',
      slug: 'email_old_profile',
      profileId: 'profile-active-inbox',
      profileMetadata: {
        connector_slug: 'email_active_profile',
        inbox_id: 'inb_active',
      },
    };
    const fetchCalls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const deps: GatewayDeps = {
      loadConnectorBySlug: async (_projectId, slug) =>
        slug === 'email_old_profile' ? staleProfileConnector : null,
      loadAction: async (connectorId, relPath) =>
        connectorId === staleProfileConnector.connectorId && relPath === 'reply_message'
          ? EMAIL_REPLY
          : null,
      resolveCredential: async () => 'am_stale_profile_token',
      loadEmailSessionContext: async () => ({
        inboxId: 'inb_active',
        threadId: 'thr_active',
        messageId: 'msg_active',
      }),
      resolveEmailCredentialForInbox: async (_projectId, inboxId) =>
        inboxId === 'inb_active' ? 'am_active_inbox_token' : null,
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, ...init });
        return { status: 200, ok: true, text: async () => '{"message_id":"msg-reply"}' };
      },
    };

    const res = await handleCall(deps, {
      ...input,
      connectorSlug: 'email_old_profile',
      actionPath: 'reply_message',
      args: { inbox_id: 'inb_deleted', message_id: 'msg_deleted', text: 'Thanks' },
    });

    expect(res.status).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
    const call = expectDefined(fetchCalls[0]);
    expect(call.url).toBe(
      'https://api.agentmail.to/v0/inboxes/inb_active/messages/msg_active/reply',
    );
    expect(call.headers.Authorization).toBe('Bearer am_active_inbox_token');
    expect(JSON.parse(expectDefined(call.body))).toEqual({ text: 'Thanks' });
  });

  test('email profile connector calls use the installed inbox instead of caller-provided inbox_id', async () => {
    const profileConnector: GatewayConnector = {
      ...EMAIL,
      connectorId: 'conn-email-profile',
      slug: 'email_fabian_u7vq',
    };
    const fetchCalls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const deps: GatewayDeps = {
      loadConnectorBySlug: async (_projectId, slug) =>
        slug === 'email_fabian_u7vq' ? profileConnector : null,
      loadAction: async (connectorId, relPath) =>
        connectorId === profileConnector.connectorId && relPath === 'list_messages'
          ? EMAIL_LIST_MESSAGES
          : null,
      resolveCredential: async () => 'am_profile_token',
      loadEmailConnectorContext: async (_projectId, connectorSlug) =>
        connectorSlug === 'email_fabian_u7vq' ? { inboxId: 'email-inbox@agentmail.to' } : null,
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, ...init });
        return { status: 200, ok: true, text: async () => '{"messages":[]}' };
      },
    };

    const res = await handleCall(deps, {
      ...input,
      sessionId: null,
      connectorSlug: 'email_fabian_u7vq',
      actionPath: 'list_messages',
      args: { inbox_id: 'email_fabian_u7vq', limit: 1 },
    });

    expect(res.status).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
    const call = expectDefined(fetchCalls[0]);
    expect(call.url).toBe(
      'https://api.agentmail.to/v0/inboxes/email-inbox%40agentmail.to/messages?limit=1',
    );
    expect(call.headers.Authorization).toBe('Bearer am_profile_token');
  });
});

/* ─── gateway execution — voice ──────────────────────────────────────────── */

const VOICE: GatewayConnector = {
  connectorId: 'conn-voice',
  slug: VOICE_CHANNEL_CONNECTOR_SLUG,
  provider: 'channel',
  platform: 'voice',
  baseUrl: '',
  auth: { type: 'none', in: 'header', name: null, prefix: null },
  hasAuth: false,
  credentialMode: 'shared',
  enabled: true,
};

const SPAWN_ROOM: GatewayAction = {
  path: 'spawn_room',
  relPath: 'spawn_room',
  inputSchema: { type: 'object', properties: { voice: {} } },
  risk: 'write',
  binding: { kind: 'voice', op: 'spawn_room' },
};

const JOIN_GMEET: GatewayAction = {
  path: 'join_gmeet',
  relPath: 'join_gmeet',
  inputSchema: { type: 'object', properties: { meeting_url: {} }, required: ['meeting_url'] },
  risk: 'write',
  binding: { kind: 'voice', op: 'join_gmeet' },
};

const voiceInput: CallInput = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  subject: { userId: 'u1', groupIds: [] },
  sessionId: 'sess-1',
  connectorSlug: VOICE_CHANNEL_CONNECTOR_SLUG,
  actionPath: 'spawn_room',
  args: {},
};

describe('handleCall — channel (voice)', () => {
  test('spawn_room routes through executeVoiceCall (never executeCall/fetch) and returns its data', async () => {
    const seen: { op: string | null; args: Record<string, unknown> | null } = { op: null, args: null };
    let fetchCalled = false;
    const deps: GatewayDeps = {
      loadConnectorBySlug: async () => VOICE,
      loadAction: async () => SPAWN_ROOM,
      resolveCredential: async () => {
        throw new Error('spawn_room has no credential — resolveCredential must not be called');
      },
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async () => {
        fetchCalled = true;
        return { status: 200, ok: true, text: async () => '{}' };
      },
      executeVoiceCall: async ({ op, args }) => {
        seen.op = op;
        seen.args = args;
        return { ok: true, data: { call_id: 'sess-1', join_url: 'https://app.example.com/voice/tok' } };
      },
    };

    const res = await handleCall(deps, { ...voiceInput, args: { voice: 'rex' } });

    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data).toEqual({ call_id: 'sess-1', join_url: 'https://app.example.com/voice/tok' });
    }
    expect(seen.op).toBe('spawn_room');
    expect(seen.args).toEqual({ voice: 'rex' });
    expect(fetchCalled).toBe(false); // no third-party HTTP call for voice
  });

  test('join_gmeet / join_zoom come back as a clear not-implemented error, not a silent no-op', async () => {
    const deps: GatewayDeps = {
      loadConnectorBySlug: async () => VOICE,
      loadAction: async () => JOIN_GMEET,
      resolveCredential: async () => null,
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{}' }),
      executeVoiceCall: async ({ op }) => ({
        ok: false,
        kind: 'not_implemented',
        message: `joining an existing Google Meet is not supported yet — use spawn_room and share the join link instead (op=${op})`,
      }),
    };

    const res = await handleCall(deps, {
      ...voiceInput,
      actionPath: 'join_gmeet',
      args: { meeting_url: 'https://meet.google.com/abc-defg-hij' },
    });

    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.reason).toMatch(/not supported yet/);
      expect(res.reason).toMatch(/spawn_room/);
    }
  });

  test('missing executeVoiceCall wiring fails loud instead of silently no-opping', async () => {
    const deps: GatewayDeps = {
      loadConnectorBySlug: async () => VOICE,
      loadAction: async () => SPAWN_ROOM,
      resolveCredential: async () => null,
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{}' }),
      // executeVoiceCall intentionally omitted
    };

    const res = await handleCall(deps, voiceInput);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toMatch(/voice runner not wired/);
  });

  test('a policy block on the voice connector still applies — the action never even reaches executeVoiceCall', async () => {
    let called = false;
    const deps: GatewayDeps = {
      loadConnectorBySlug: async () => VOICE,
      loadAction: async () => SPAWN_ROOM,
      resolveCredential: async () => null,
      loadPolicies: async () => [{ match: 'spawn_room', action: 'block', position: 0 }],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => null,
      fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{}' }),
      executeVoiceCall: async () => {
        called = true;
        return { ok: true, data: {} };
      },
    };

    const res = await handleCall(deps, voiceInput);
    expect(res.status).toBe('denied');
    expect(called).toBe(false);
  });
});
