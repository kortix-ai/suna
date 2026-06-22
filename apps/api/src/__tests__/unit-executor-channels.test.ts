/**
 * Channel connectors (Slack as a first-class Executor connector).
 *   • catalog — the fixed Slack action set normalizes to http bindings against
 *     the Slack Web API, with native param names + correct verbs/risks.
 *   • parse   — `provider="channel" platform="slack"` round-trips; bad platform
 *     and a declared auth table are rejected.
 *   • gateway — a channel call builds the right slack.com/api request with the
 *     install token as a bearer, and Slack's HTTP-200 `{ok:false}` envelope is
 *     surfaced as a real error (parity with the in-sandbox CLI's throw).
 */
import { describe, expect, test } from 'bun:test';
import { channelApiBase, channelCatalog, channelDefaultSlug, SLACK_CHANNEL_CONNECTOR_SLUG } from '../executor/channels';
import {
  extractConnectors,
  connectorSpecToTomlEntry,
} from '../projects/connectors';
import { parseManifestString, KNOWN_SCHEMA_VERSION } from '../projects/triggers';
import {
  handleCall,
  type CallInput,
  type GatewayConnector,
  type GatewayAction,
  type GatewayDeps,
} from '../executor/gateway';

/* ─── catalog ─────────────────────────────────────────────────────────────── */

describe('channelCatalog(slack)', () => {
  const actions = channelCatalog('slack');
  const byPath = new Map(actions.map((a) => [a.path, a]));

  test('exposes the full native Slack surface as http bindings', () => {
    // 14 native Web API methods (relay/typing/download/manifest/file-upload are CLI-side).
    expect(actions.length).toBe(14);
    for (const a of actions) {
      expect(a.binding.kind).toBe('http');
      if (a.binding.kind === 'http') expect(a.binding.path.startsWith('/')).toBe(true);
    }
  });

  test('send_message → POST /chat.postMessage, write, channel required', () => {
    const a = byPath.get('send_message')!;
    expect(a.binding).toEqual({ kind: 'http', method: 'POST', path: '/chat.postMessage' });
    expect(a.risk).toBe('write');
    expect((a.inputSchema as any).required).toContain('channel');
  });

  test('get_history → GET /conversations.history, read', () => {
    const a = byPath.get('get_history')!;
    expect(a.binding).toEqual({ kind: 'http', method: 'GET', path: '/conversations.history' });
    expect(a.risk).toBe('read');
  });

  test('delete_message is destructive; reactions use Slack native param names', () => {
    expect(byPath.get('delete_message')!.risk).toBe('destructive');
    const react = byPath.get('add_reaction')!;
    const props = Object.keys((react.inputSchema as any).properties);
    expect(props).toEqual(['channel', 'timestamp', 'name']); // not ts/emoji — Slack's own names
  });

  test('auth_test has no inputs; unknown platform → empty', () => {
    expect(byPath.get('auth_test')!.inputSchema).toBeNull();
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

/* ─── parse ───────────────────────────────────────────────────────────────── */

function parse(body: string) {
  const src = [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, '\n[project]\nname = "t"\n', body].join('\n');
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
    expect(connectorSpecToTomlEntry(specs[0]!)).toMatchObject({ provider: 'channel', platform: 'slack' });
  });

  test('missing / unknown platform is rejected', () => {
    expect(parse(`
[[connectors]]
slug = "x"
provider = "channel"
`).errors[0]!.error).toMatch(/platform/);
    expect(parse(`
[[connectors]]
slug = "x"
provider = "channel"
platform = "discord"
`).errors[0]!.error).toMatch(/platform/);
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
    expect(errors[0]!.error).toMatch(/install token/);
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
  shareScope: 'project',
  grants: [],
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

function makeDeps(body: string, status = 200) {
  const fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => SLACK,
    loadAction: async () => SEND,
    resolveCredential: async () => 'xoxb-install-token',
    loadPolicies: async () => [],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    recordExecution: async () => {},
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
    expect(fetchCalls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(fetchCalls[0]!.method).toBe('POST');
    expect(fetchCalls[0]!.headers.Authorization).toBe('Bearer xoxb-install-token');
    expect(JSON.parse(fetchCalls[0]!.body!)).toEqual({ channel: 'C123', text: 'hi' });
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
      shareScope: 'project',
      grants: [],
      credentialMode: 'shared',
      enabled: true,
    };
    const getThread: GatewayAction = {
      path: `${SLACK_CHANNEL_CONNECTOR_SLUG}.get_thread`,
      relPath: 'get_thread',
      inputSchema: { type: 'object', properties: { channel: {}, ts: {} }, required: ['channel', 'ts'] },
      risk: 'read',
      binding: { kind: 'http', method: 'GET', path: '/conversations.replies' },
    };
    const fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const deps: GatewayDeps = {
      loadConnectorBySlug: async (_projectId, slug) => {
        if (slug === SLACK_CHANNEL_CONNECTOR_SLUG) return SLACK;
        if (slug === 'slack') return pipedreamSlack;
        return null;
      },
      loadAction: async (connectorId, relPath) => connectorId === SLACK.connectorId && relPath === 'get_thread' ? getThread : null,
      resolveCredential: async (connector) => connector.provider === 'channel' ? 'xoxb-install-token' : 'pipedream-account-id',
      loadPolicies: async () => [],
      loadProjectPolicies: async () => [],
      loadDefaultMode: async () => 'allow_all',
      recordExecution: async () => {},
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
