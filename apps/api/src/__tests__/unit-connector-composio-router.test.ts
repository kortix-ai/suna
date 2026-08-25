import { describe, expect, test } from 'bun:test';
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';

const PROJECT = 'proj-composio';
const ADMIN = { 'x-test-admin': 'user-1' };

function deps(overrides: Partial<ConnectorRouterDeps>): ConnectorRouterDeps {
  return {
    featureFlagEnabled: async () => true,
    resolvePrincipal: async () => null,
    resolveProjectPrincipal: async () => null,
    makeGatewayDeps: (() => ({} as unknown)) as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async (c) =>
      c.req.header('x-test-admin') ? { accountId: 'acct-1', userId: 'user-1' } : null,
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    ...overrides,
  };
}

function request(app: ReturnType<typeof createConnectorRouter>, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://x${path}`, init));
}

describe('connector router provider-neutral connect routes', () => {
  test('connect forwards the requesting session id so finalize can resume that agent', async () => {
    const seen: Array<string | null | undefined> = [];
    const app = createConnectorRouter(
      deps({
        // The auth middleware sets `sessionId` from a scoped session token, which
        // is exactly the in-sandbox agent case. A human clicking Connect in
        // project settings carries no session and must forward null.
        resolveAdmin: async (c) => {
          if (!c.req.header('x-test-admin')) return null;
          const sid = c.req.header('x-test-session');
          if (sid) c.set('sessionId', sid);
          return { accountId: 'acct-1', userId: 'user-1' };
        },
        connectorConnect: async (_projectId, _slug, _userId, _redirects, requestingSessionId) => {
          seen.push(requestingSessionId);
          return { provider: 'composio', connectUrl: 'https://connect.example/link' };
        },
      }),
    );

    const agent = await request(app, `/projects/${PROJECT}/connectors/gmail/connect`, {
      method: 'POST',
      headers: { ...ADMIN, 'x-test-session': 'session-abc' },
    });
    expect(agent.status).toBe(200);

    const human = await request(app, `/projects/${PROJECT}/connectors/gmail/connect`, {
      method: 'POST',
      headers: ADMIN,
    });
    expect(human.status).toBe(200);

    expect(seen).toEqual(['session-abc', null]);
  });

  test('connect-requests lists what this session asked a human to authorize', async () => {
    const app = createConnectorRouter(
      deps({
        listSessionConnectRequests: async (projectId, sessionId) => [
          { slug: 'gmail', app: 'gmail', provider: 'composio', connected: false },
          { slug: `${projectId}:${sessionId}`, app: 'slack', provider: 'pipedream', connected: true },
        ],
      }),
    );

    const res = await request(app, `/projects/${PROJECT}/sessions/session-abc/connect-requests`, {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connectors: [
        { slug: 'gmail', app: 'gmail', provider: 'composio', connected: false },
        { slug: `${PROJECT}:session-abc`, app: 'slack', provider: 'pipedream', connected: true },
      ],
    });
  });

  test('connect-requests is forbidden without project admin', async () => {
    const app = createConnectorRouter(deps({ listSessionConnectRequests: async () => [] }));
    const res = await request(app, `/projects/${PROJECT}/sessions/session-abc/connect-requests`);
    expect(res.status).toBe(403);
  });

  test('connect-status returns Composio as the configured provider when wired', async () => {
    const app = createConnectorRouter(
      deps({
        connectStatus: async () => ({ configured: true, provider: 'composio', providers: ['composio'] }),
      }),
    );

    const res = await request(app, '/connect-status', { headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      provider: 'composio',
      providers: ['composio'],
    });
  });

  test('toolkit discovery forwards pagination', async () => {
    const app = createConnectorRouter(deps({ listConnectToolkits: async (projectId, input) => ({ provider: 'composio', projectId, input }) }));
    const res = await request(app, `/projects/${PROJECT}/connect/toolkits?q=remote&category=productivity&cursor=next&limit=25`, { headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: 'composio', projectId: PROJECT, input: { q: 'remote', category: 'productivity', cursor: 'next', limit: 25 } });
  });

  test('connect and finalize call provider-neutral deps with connection selector', async () => {
    const calls: string[] = [];
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const app = createConnectorRouter(
      deps({
        connectorConnect: async (_projectId, slug, _userId, redirects) => {
          calls.push(`connect:${slug}:${redirects?.success ?? ''}`);
          return { provider: 'composio', app: 'composio', connected: true, isNoAuth: true, sessionId: 'session_1', connectionId };
        },
        connectorFinalize: async (_projectId, slug, _userId, selector) => {
          calls.push(`finalize:${slug}:${selector?.connectionId}:${selector?.requestId}`);
          return { provider: 'composio', connected: true, isNoAuth: true, connectionId };
        },
      }),
    );

    const connect = await request(app, `/projects/${PROJECT}/connectors/github/connect`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ success_redirect_uri: 'kortix://success' }),
    });
    expect(connect.status).toBe(200);
    expect(await connect.json()).toMatchObject({
      provider: 'composio',
      app: 'composio', connected: true, isNoAuth: true, connectionId,
    });

    const finalize = await request(app, `/projects/${PROJECT}/connectors/github/connect/finalize`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ connection_id: connectionId, request_id: 'req_1' }),
    });
    expect(finalize.status).toBe(200);
    expect(await finalize.json()).toEqual({
      provider: 'composio',
      connected: true,
      isNoAuth: true,
      connectionId,
    });
    expect(calls).toEqual(['connect:github:kortix://success', `finalize:github:${connectionId}:req_1`]);
  });

  test('legacy Pipedream deps remain a rollback path', async () => {
    const app = createConnectorRouter(deps({
      pipedreamConnect: async () => ({ app: 'github', token: 'rollback-token' }),
      pipedreamFinalize: async () => ({ connected: true, accountId: 'pd-account' }),
    }));
    const connect = await request(app, `/projects/${PROJECT}/connectors/github/connect`, { method: 'POST', headers: ADMIN });
    expect(await connect.json()).toEqual({ provider: 'pipedream', app: 'github', token: 'rollback-token' });
    const finalize = await request(app, `/projects/${PROJECT}/connectors/github/connect/finalize`, { method: 'POST', headers: ADMIN });
    expect(await finalize.json()).toEqual({ provider: 'pipedream', connected: true, accountId: 'pd-account' });
  });
});
