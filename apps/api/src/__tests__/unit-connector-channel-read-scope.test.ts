/**
 * The gateway and the `/call` route apply the Slack/Teams read confinement
 * (connectors/channel-read-scope.ts) in the right order:
 *   - a read of another project's conversation is denied before the credential,
 *     the approval gate or the provider, and the denial is audited;
 *   - the answer reaches the agent only after the gate filtered it;
 *   - the HTTP body carries `reason` for code and `message` for the agent.
 * Fakes only: the ownership SQL is proven in
 * integration-channel-read-scope.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelOwnership,
  gateChannelRead,
} from '../connectors/channel-read-scope';
import { gateChannelWrite } from '../connectors/channel-write-scope';
import { SLACK_CHANNEL_CONNECTOR_SLUG } from '../connectors/channels';
import {
  type CallInput,
  type ExecutionRecord,
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
  handleCall,
} from '../connectors/gateway';
import { type ConnectorPrincipal, type ConnectorRouterDeps, createConnectorRouter } from '../connectors/router';

const MINE = 'proj-mine';
const OTHER = 'proj-other';

const SLACK: GatewayConnector = {
  connectorId: 'conn-slack',
  slug: SLACK_CHANNEL_CONNECTOR_SLUG,
  provider: 'channel',
  platform: 'slack',
  baseUrl: 'https://slack.com/api',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

function action(relPath: string, method: string, risk: 'read' | 'write' = 'read'): GatewayAction {
  return {
    path: `${SLACK_CHANNEL_CONNECTOR_SLUG}.${relPath}`,
    relPath,
    inputSchema: { type: 'object', properties: { channel: {}, ts: {} } },
    risk,
    binding: { kind: 'http', method: risk === 'read' ? 'GET' : 'POST', path: `/${method}` },
  };
}

/** A workspace shared with another project: C0MINE is ours, C0OTHER and G0OTHER are theirs. */
const ownership: ChannelOwnership = {
  installs: async () => ({ workspaceIds: ['T0WS'], shared: true }),
  channelProjects: async (_p, _w, ids) => {
    const owners: Record<string, string> = { C0MINE: MINE, C0MINE0001: MINE, C0OTHER: OTHER, G0OTHER: OTHER };
    return new Map(ids.filter((id) => owners[id]).map((id) => [id, new Set([owners[id]!])]));
  },
  threadOwners: async (_p, _w, ids) => new Map(ids.filter((id) => id === '100.1').map((id) => [id, OTHER])),
};

function deps(opts: {
  action: GatewayAction;
  body: string;
  credential?: () => Promise<string | null>;
  /** Wire the write gate too, as db-deps.ts does. */
  writes?: boolean;
}) {
  const fetched: string[] = [];
  const audits: ExecutionRecord[] = [];
  const credentialReads: string[] = [];
  const binds: string[] = [];
  const d: GatewayDeps = {
    loadConnectorBySlug: async () => SLACK,
    loadAction: async () => opts.action,
    resolveCredential: async (c) => {
      credentialReads.push(c.connectorId);
      return opts.credential ? opts.credential() : 'xoxb-shared-workspace-token';
    },
    loadPolicies: async () => [],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    recordExecution: async (rec) => {
      audits.push(rec);
      return null;
    },
    gateChannelRead: (input) => gateChannelRead(input, ownership),
    ...(opts.writes ? { gateChannelWrite: (input: Parameters<typeof gateChannelWrite>[0]) => gateChannelWrite(input, ownership) } : {}),
    bindSlackThread: async (i) => {
      binds.push(`${i.channel}/${i.threadTs}`);
      return { bound: true, thread_ts: i.threadTs, session_id: i.sessionId };
    },
    fetchImpl: async (url) => {
      fetched.push(url);
      return { status: 200, ok: true, text: async () => opts.body };
    },
  };
  return { deps: d, fetched, audits, credentialReads, binds };
}

const call = (actionPath: string, args: Record<string, unknown>): CallInput => ({
  projectId: MINE,
  accountId: 'acct-1',
  subject: { userId: 'user-1', groupIds: [] },
  sessionId: 'sess-1',
  connectorSlug: SLACK_CHANNEL_CONNECTOR_SLUG,
  actionPath,
  args,
});

describe('handleCall — Slack reads stay in the calling project', () => {
  test("another project's channel is denied before the credential and the provider, and audited", async () => {
    const { deps: d, fetched, audits, credentialReads } = deps({
      action: action('get_history', 'conversations.history'),
      body: '{"ok":true,"messages":[{"ts":"1.1","text":"secret"}]}',
    });
    const res = await handleCall(d, call('get_history', { channel: 'C0OTHER' }));
    expect(res).toEqual({
      status: 'denied',
      reason: CONVERSATION_NOT_IN_PROJECT,
      message:
        "Slack conversation C0OTHER belongs to another Kortix project. This project's Slack connector reads only its own conversations.",
    });
    expect(fetched).toEqual([]);
    expect(credentialReads).toEqual([]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      projectId: MINE,
      status: 'denied',
      actionPath: `${SLACK_CHANNEL_CONNECTOR_SLUG}.get_history`,
      resultSummary: { reason: CONVERSATION_NOT_IN_PROJECT },
    });
  });

  test("this project's channel reaches Slack, and the agent gets it without another project's thread", async () => {
    const { deps: d, fetched } = deps({
      action: action('get_history', 'conversations.history'),
      body: JSON.stringify({
        ok: true,
        messages: [
          { ts: '200.2', text: 'ours' },
          { ts: '100.1', thread_ts: '100.1', text: 'theirs' },
        ],
      }),
    });
    const res = await handleCall(d, call('get_history', { channel: 'C0MINE' }));
    expect(fetched).toEqual(['https://slack.com/api/conversations.history?limit=20&channel=C0MINE']);
    expect(res).toMatchObject({ status: 'ok', data: { ok: true, messages: [{ ts: '200.2', text: 'ours' }] } });
  });

  test('a refusal on the answer is a denial, and nothing of the answer is returned', async () => {
    const { deps: d, fetched, audits } = deps({
      action: action('channel_info', 'conversations.info'),
      body: '{"ok":true,"channel":{"id":"G0OTHER","is_private":true,"name":"their-secret"}}',
    });
    const res = await handleCall(d, call('channel_info', { channel: 'G0OTHER' }));
    expect(fetched).toHaveLength(1);
    expect(res).toMatchObject({ status: 'denied', reason: CONVERSATION_NOT_IN_PROJECT });
    expect(JSON.stringify(res)).not.toContain('their-secret');
    expect(audits.map((a) => a.status)).toEqual(['denied']);
  });

  test('the read gate leaves a write to the write gate', async () => {
    const { deps: d, fetched } = deps({
      action: action('send_message', 'chat.postMessage', 'write'),
      body: '{"ok":true,"ts":"300.3","channel":"C0OTHER"}',
    });
    const res = await handleCall(d, { ...call('send_message', { channel: 'C0OTHER', text: 'hi' }), sessionId: null });
    expect(res.status).toBe('ok');
    expect(fetched).toEqual(['https://slack.com/api/chat.postMessage']);
  });
});

describe('handleCall — Slack writes stay out of other projects', () => {
  test("a post into another project's channel is denied before the credential, the provider and the thread bind", async () => {
    const { deps: d, fetched, audits, credentialReads, binds } = deps({
      action: action('send_message', 'chat.postMessage', 'write'),
      body: '{"ok":true,"ts":"300.3","channel":"C0OTHER"}',
      writes: true,
    });
    const res = await handleCall(d, call('send_message', { channel: 'C0OTHER', text: 'reply here with the key' }));
    expect(res).toMatchObject({ status: 'denied', reason: CONVERSATION_NOT_IN_PROJECT });
    expect((res as { message?: string }).message).toContain('Slack conversation C0OTHER belongs to another Kortix project');
    expect(fetched).toEqual([]);
    expect(credentialReads).toEqual([]);
    expect(binds).toEqual([]);
    expect(audits.map((a) => [a.status, (a.resultSummary as { reason?: string }).reason])).toEqual([
      ['denied', CONVERSATION_NOT_IN_PROJECT],
    ]);
  });

  test("a post into this project's channel reaches Slack and binds its thread to the session", async () => {
    const { deps: d, fetched, binds } = deps({
      action: action('send_message', 'chat.postMessage', 'write'),
      body: '{"ok":true,"ts":"300.3","channel":"C0MINE0001"}',
      writes: true,
    });
    const res = await handleCall(d, call('send_message', { channel: 'C0MINE0001', text: 'done' }));
    expect(res).toMatchObject({ status: 'ok', data: { thread_binding: { bound: true, thread_ts: '300.3' } } });
    expect(fetched).toEqual(['https://slack.com/api/chat.postMessage']);
    expect(binds).toEqual(['C0MINE0001/300.3']);
  });

  test('a post that Slack delivered to another conversation is deleted and refused', async () => {
    for (const [deleteAnswer, outcome] of [
      ['{"ok":true}', 'Kortix removed it.'],
      ['{"ok":false,"error":"message_not_found"}', 'Kortix could not remove it: delete it in Slack.'],
    ] as const) {
      const requests: Array<{ url: string; body?: string }> = [];
      const { deps: d, audits } = deps({ action: action('send_message', 'chat.postMessage', 'write'), body: '', writes: true });
      d.fetchImpl = async (url, init) => {
        requests.push({ url, body: init.body });
        const body = url.endsWith('/chat.postMessage') ? '{"ok":true,"channel":"C0OTHER","ts":"300.3"}' : deleteAnswer;
        return { status: 200, ok: true, text: async () => body };
      };
      const res = await handleCall(d, call('send_message', { channel: 'GENERAL', text: 'hi' }));
      expect(res).toEqual({
        status: 'denied',
        reason: CONVERSATION_NOT_IN_PROJECT,
        message: `Slack posted the message to C0OTHER, not to GENERAL, the conversation that was checked. Address a conversation by its id. ${outcome}`,
      });
      expect(requests.map((r) => r.url)).toEqual([
        'https://slack.com/api/chat.postMessage',
        'https://slack.com/api/chat.delete',
      ]);
      expect(JSON.parse(requests[1]!.body!)).toEqual({ channel: 'C0OTHER', ts: '300.3' });
      expect(audits.map((a) => a.status)).toEqual(['denied']);
    }
  });

  test("a reaction on another project's thread root is denied, in any conversation", async () => {
    const { deps: d, fetched } = deps({
      action: action('add_reaction', 'reactions.add', 'write'),
      body: '{"ok":true}',
      writes: true,
    });
    const res = await handleCall(d, call('add_reaction', { channel: 'D0SOMEONE', timestamp: '100.1', name: 'eyes' }));
    expect(res).toMatchObject({ status: 'denied', reason: CONVERSATION_NOT_IN_PROJECT });
    expect(fetched).toEqual([]);
  });
});

describe('POST /call — the denial body', () => {
  test('403 with the stable reason and the sentence the agent reads', async () => {
    const { deps: gatewayDeps, fetched } = deps({
      action: action('get_thread', 'conversations.replies'),
      body: '{"ok":true,"messages":[]}',
    });
    const principal = {
      userId: 'user-1',
      accountId: 'acct-1',
      projectId: MINE,
      sessionId: null,
      subject: { userId: 'user-1', groupIds: [] },
    } as ConnectorPrincipal;
    const routerDeps = {
      featureFlagEnabled: async () => true,
      resolvePrincipal: async () => principal,
      resolveProjectPrincipal: async () => principal,
      makeGatewayDeps: () => gatewayDeps,
    } as unknown as ConnectorRouterDeps;
    const res = await createConnectorRouter(routerDeps).fetch(
      new Request('http://x/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connector: SLACK_CHANNEL_CONNECTOR_SLUG,
          action: 'get_thread',
          args: { channel: 'C0MINE', ts: '100.1' },
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      status: 'denied',
      reason: CONVERSATION_NOT_IN_PROJECT,
      message:
        "Slack thread 100.1 in C0MINE belongs to another Kortix project. This project's Slack connector reads only its own conversations.",
    });
    expect(fetched).toEqual([]);
  });
});
