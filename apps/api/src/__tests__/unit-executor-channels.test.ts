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
import { config } from '../config';
import {
  EMAIL_CHANNEL_CONNECTOR_SLUG,
  MEET_CHANNEL_CONNECTOR_SLUG,
  SLACK_CHANNEL_CONNECTOR_SLUG,
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

describe('channelCatalog(meet)', () => {
  const actions = channelCatalog('meet');
  const byPath = new Map(actions.map((a) => [a.path, a]));
  const action = (path: string) => expectDefined(byPath.get(path));

  test('exposes the Recall.ai meeting-bot lifecycle + transcript + chat as http bindings', () => {
    expect(actions.map((a) => a.path).sort()).toEqual([
      'bot_status',
      'get_transcript',
      'join_meeting',
      'leave_meeting',
      'send_chat_message',
    ]);
    for (const a of actions) {
      expect(a.binding.kind).toBe('http');
      if (a.binding.kind === 'http') expect(a.binding.path.startsWith('/')).toBe(true);
    }
  });

  test('send_chat_message → POST /bot/{id}/send_chat_message/, write, id+message required', () => {
    const a = action('send_chat_message');
    expect(a.binding).toEqual({
      kind: 'http',
      method: 'POST',
      path: '/bot/{id}/send_chat_message/',
    });
    expect(a.risk).toBe('write');
    expect(objectSchema(a.inputSchema).required).toEqual(['id', 'message']);
    expect((objectSchema(a.inputSchema).properties as Record<string, any>).id['x-in']).toBe('path');
  });

  test('join_meeting → POST /bot/ (trailing slash), write, meeting_url required', () => {
    const a = action('join_meeting');
    expect(a.binding).toEqual({ kind: 'http', method: 'POST', path: '/bot/' });
    expect(a.risk).toBe('write');
    expect(objectSchema(a.inputSchema).required).toEqual(['meeting_url']);
  });

  test('leave_meeting → POST /bot/{id}/leave_call/ with id as a path param', () => {
    const a = action('leave_meeting');
    expect(a.binding).toEqual({
      kind: 'http',
      method: 'POST',
      path: '/bot/{id}/leave_call/',
    });
    expect((objectSchema(a.inputSchema).properties as Record<string, any>).id['x-in']).toBe('path');
  });

  test('get_transcript → GET /transcript/ filtered by bot_id; bot_status → GET /bot/{id}/', () => {
    const t = action('get_transcript');
    expect(t.binding).toEqual({ kind: 'http', method: 'GET', path: '/transcript/' });
    expect(t.risk).toBe('read');
    // bot_id has no x-in hint → on a GET it becomes a query param (?bot_id=…).
    expect(
      (objectSchema(t.inputSchema).properties as Record<string, any>).bot_id['x-in'],
    ).toBeUndefined();
    expect(objectSchema(t.inputSchema).required).toEqual(['bot_id']);
    const s = action('bot_status');
    expect(s.binding).toEqual({ kind: 'http', method: 'GET', path: '/bot/{id}/' });
    expect((objectSchema(s.inputSchema).properties as Record<string, any>).id['x-in']).toBe('path');
  });

  test('api base = the configured Recall gateway; default slug is platform-owned', () => {
    expect(channelApiBase('meet')).toBe(config.RECALL_BASE_URL);
    expect(channelDefaultSlug('meet')).toBe(MEET_CHANNEL_CONNECTOR_SLUG);
    expect(MEET_CHANNEL_CONNECTOR_SLUG).toBe('kortix_meet');
  });

  test('meet auth is `Authorization: Token …` (custom header), not Bearer', () => {
    expect(channelAuth('meet')).toEqual({
      type: 'custom',
      in: 'header',
      name: 'Authorization',
      prefix: 'Token ',
    });
    expect(channelAuth('slack')).toEqual({
      type: 'bearer',
      in: 'header',
      name: null,
      prefix: null,
    });
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

/* ─── gateway execution — meet (Recall.ai) ────────────────────────────────── */

const MEET: GatewayConnector = {
  connectorId: 'conn-meet',
  slug: MEET_CHANNEL_CONNECTOR_SLUG,
  provider: 'channel',
  platform: 'meet',
  baseUrl: 'https://us-west-2.recall.ai/api/v1',
  auth: { type: 'custom', in: 'header', name: 'Authorization', prefix: 'Token ' },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const MEET_JOIN: GatewayAction = {
  path: `${MEET_CHANNEL_CONNECTOR_SLUG}.join_meeting`,
  relPath: 'join_meeting',
  inputSchema: {
    type: 'object',
    properties: { meeting_url: {}, bot_name: {}, recording_config: {} },
    required: ['meeting_url'],
  },
  risk: 'write',
  binding: { kind: 'http', method: 'POST', path: '/bot/' },
};

const MEET_TRANSCRIPT: GatewayAction = {
  path: `${MEET_CHANNEL_CONNECTOR_SLUG}.get_transcript`,
  relPath: 'get_transcript',
  inputSchema: {
    type: 'object',
    properties: { bot_id: {} },
    required: ['bot_id'],
  },
  risk: 'read',
  binding: { kind: 'http', method: 'GET', path: '/transcript/' },
};

function meetDeps(action: GatewayAction, body: string, status = 200) {
  const fetchCalls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => MEET,
    loadAction: async () => action,
    resolveCredential: async () => 'recall_test_key',
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

describe('handleCall — channel (meet)', () => {
  test('join_meeting POSTs /bot/ with the Recall key as `Authorization: Token …` (never Bearer)', async () => {
    const { deps, fetchCalls } = meetDeps(MEET_JOIN, '{"id":"bot_abc","status_changes":[]}', 201);
    const res = await handleCall(deps, {
      ...input,
      connectorSlug: MEET_CHANNEL_CONNECTOR_SLUG,
      actionPath: 'join_meeting',
      args: { meeting_url: 'https://meet.google.com/abc-defg-hij' },
    });
    expect(res.status).toBe('ok');
    const call = expectDefined(fetchCalls[0]);
    expect(call.url).toBe('https://us-west-2.recall.ai/api/v1/bot/');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Token recall_test_key');
    expect(JSON.parse(expectDefined(call.body))).toEqual({
      meeting_url: 'https://meet.google.com/abc-defg-hij',
    });
  });

  test('join_meeting injects the realtime webhook + bot metadata server-side (live relay)', async () => {
    const { deps, fetchCalls } = meetDeps(MEET_JOIN, '{"id":"bot_abc"}', 201);
    deps.resolveMeetJoinContext = async (projectId, sessionId) => ({
      metadata: {
        kortix_project_id: projectId,
        kortix_session_id: sessionId,
        kortix_token: 'sig',
        kortix_wake: 'kortix',
      },
      realtimeEndpoints: [
        {
          type: 'webhook',
          url: 'https://pub.example/v1/webhooks/meet/realtime',
          events: ['transcript.data'],
        },
      ],
      automaticAudioOutput: { in_call_recording: { data: { kind: 'mp3', b64_data: 'c2lsZW50' } } },
      botName: 'Acme Notetaker',
    });
    const res = await handleCall(deps, {
      ...input,
      sessionId: 'sess-xyz',
      connectorSlug: MEET_CHANNEL_CONNECTOR_SLUG,
      actionPath: 'join_meeting',
      args: {
        meeting_url: 'https://meet.google.com/abc-defg-hij',
        recording_config: { transcript: { provider: { meeting_captions: {} } } },
      },
    });
    expect(res.status).toBe('ok');
    const body = JSON.parse(expectDefined(expectDefined(fetchCalls[0]).body));
    // Caller's recording_config (transcript provider) is preserved …
    expect(body.recording_config.transcript).toEqual({ provider: { meeting_captions: {} } });
    // … and the realtime webhook + session-tagged metadata are merged in.
    expect(body.recording_config.realtime_endpoints).toEqual([
      {
        type: 'webhook',
        url: 'https://pub.example/v1/webhooks/meet/realtime',
        events: ['transcript.data'],
      },
    ]);
    expect(body.metadata).toMatchObject({ kortix_session_id: 'sess-xyz', kortix_token: 'sig' });
    // … and the bot is enabled to speak (output_audio) via automatic_audio_output.
    expect(body.automatic_audio_output).toEqual({
      in_call_recording: { data: { kind: 'mp3', b64_data: 'c2lsZW50' } },
    });
    // … and the project's configured bot name is used (caller passed none).
    expect(body.bot_name).toBe('Acme Notetaker');
  });

  test('get_transcript lists by bot_id (query param) and carries the Token header on a GET', async () => {
    const { deps, fetchCalls } = meetDeps(MEET_TRANSCRIPT, '{"results":[]}');
    const res = await handleCall(deps, {
      ...input,
      connectorSlug: MEET_CHANNEL_CONNECTOR_SLUG,
      actionPath: 'get_transcript',
      args: { bot_id: 'bot_abc' },
    });
    expect(res.status).toBe('ok');
    const call = expectDefined(fetchCalls[0]);
    expect(call.url).toBe('https://us-west-2.recall.ai/api/v1/transcript/?bot_id=bot_abc');
    expect(call.method).toBe('GET');
    expect(call.headers.Authorization).toBe('Token recall_test_key');
    expect(call.body).toBeUndefined();
  });
});
