import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const SESSION_ID = '00000000-0000-4000-a000-000000000301';
const USER_ID = '00000000-0000-4000-a000-000000000401';
const CONNECTOR_ID = '00000000-0000-4000-a000-000000000501';

let connectorRows: any[] = [];
let lastProxyCall: any = null;
let lastRunActionCall: any = null;
let touchedConnectorIds: string[] = [];
let providerListAppsCalls: Array<{ query?: string; limit: number }> = [];
let providerListActionsCalls: Array<{ app: string; query?: string; limit: number }> = [];

mock.module('../config', () => ({
  config: {
    API_KEY_SECRET: 'session-connectors-test-secret',
  },
}));

mock.module('../projects/connectors', () => ({
  listActiveProjectConnectors: async (accountId: string, projectId: string) =>
    connectorRows.filter((row) =>
      row.accountId === accountId &&
      row.projectId === projectId &&
      row.status === 'active',
    ),
  findActiveProjectConnector: async (input: { accountId: string; projectId: string; connectorId?: string | null; app?: string | null }) =>
    connectorRows.find((row) =>
      row.accountId === input.accountId &&
      row.projectId === input.projectId &&
      row.status === 'active' &&
      (input.connectorId ? row.connectorId === input.connectorId : row.app === input.app),
    ) ?? null,
  serializeProjectConnector: (row: any) => ({
    connector_id: row.connectorId,
    account_id: row.accountId,
    project_id: row.projectId,
    provider: row.providerName,
    app: row.app,
    app_name: row.appName,
    label: row.label,
    status: row.status,
    scopes: row.scopes,
    metadata: row.metadata,
    connected_at: row.connectedAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }),
  touchProjectConnectorLastUsed: async (connectorId: string) => {
    touchedConnectorIds.push(connectorId);
  },
}));

mock.module('../integrations/providers', () => ({
  getProviderFromRequest: async () => ({
    name: 'pipedream',
    listApps: async (query?: string, limit = 20) => {
      providerListAppsCalls.push({ query, limit });
      return {
      apps: [{ slug: 'slack', name: 'Slack', categories: ['communication'] }],
      pageInfo: { totalCount: 1, count: 1, hasMore: false },
      };
    },
    listActions: async (app: string, query?: string, limit = 50) => {
      providerListActionsCalls.push({ app, query, limit });
      return {
      app,
      actions: [{ key: 'slack-send-message', name: 'Send Message', params: [] }],
      };
    },
    proxyRequest: async (
      accountId: string,
      app: string,
      request: any,
      providerAccountId?: string,
    ) => {
      lastProxyCall = { accountId, app, request, providerAccountId };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { ok: true },
      };
    },
    runAction: async (
      accountId: string,
      actionKey: string,
      props: Record<string, unknown>,
      app: string,
      providerAccountId?: string,
    ) => {
      lastRunActionCall = { accountId, actionKey, props, app, providerAccountId };
      return { success: true, result: { ok: true } };
    },
  }),
}));

const { sessionConnectors } = await import('../router/routes/session-connectors');
const { encodeSessionConnectorToken } = await import('../shared/session-connector-token');

function connector(overrides: Record<string, unknown> = {}) {
  return {
    connectorId: CONNECTOR_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    providerName: 'pipedream',
    app: 'slack',
    appName: 'Slack',
    providerAccountId: 'apn_slack_123',
    label: 'Company Slack',
    status: 'active',
    scopes: [],
    metadata: {},
    createdBy: USER_ID,
    connectedAt: new Date('2026-01-01T00:00:00Z'),
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function token(ttlSeconds = 60) {
  return encodeSessionConnectorToken({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    ttlSeconds,
  });
}

function createApp() {
  const app = new Hono();
  app.route('/v1/router/connectors', sessionConnectors);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('session-scoped connector router', () => {
  beforeEach(() => {
    connectorRows = [connector()];
    lastProxyCall = null;
    lastRunActionCall = null;
    touchedConnectorIds = [];
    providerListAppsCalls = [];
    providerListActionsCalls = [];
  });

  test('rejects missing, invalid, and expired connector tokens', async () => {
    const app = createApp();
    expect((await app.request('/v1/router/connectors/list')).status).toBe(401);
    expect((await app.request('/v1/router/connectors/list', {
      headers: { Authorization: 'Bearer invalid.token' },
    })).status).toBe(401);
    expect((await app.request('/v1/router/connectors/list', {
      headers: { Authorization: `Bearer ${token(-1)}` },
    })).status).toBe(401);
  });

  test('lists only project-scoped active connectors without exposing provider account IDs', async () => {
    connectorRows.push(connector({
      connectorId: '00000000-0000-4000-a000-000000000502',
      projectId: '00000000-0000-4000-a000-000000000999',
    }));
    connectorRows.push(connector({
      connectorId: '00000000-0000-4000-a000-000000000503',
      status: 'revoked',
    }));

    const app = createApp();
    const res = await app.request('/v1/router/connectors/list', {
      headers: { Authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0].connector_id).toBe(CONNECTOR_ID);
    expect(body.connectors[0].provider_account_id).toBeUndefined();
  });

  test('searches available connector apps through the cloud provider', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/connectors/search-apps?q=sla&limit=7', {
      headers: { Authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(200);
    expect(providerListAppsCalls).toEqual([{ query: 'sla', limit: 7 }]);
    const body = await res.json();
    expect(body.apps).toEqual([{ slug: 'slack', name: 'Slack', categories: ['communication'] }]);
  });

  test('lists actions for an active project connector', async () => {
    const app = createApp();
    const res = await app.request(`/v1/router/connectors/actions?connector_id=${CONNECTOR_ID}&q=send&limit=3`, {
      headers: { Authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(200);
    expect(providerListActionsCalls).toEqual([{ app: 'slack', query: 'send', limit: 3 }]);
    const body = await res.json();
    expect(body).toMatchObject({
      app: 'slack',
      actions: [{ key: 'slack-send-message', name: 'Send Message', params: [] }],
    });
  });

  test('proxies through the cloud provider using the project connector binding', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/connectors/proxy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app: 'slack',
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        body: { text: 'hello' },
      }),
    });

    expect(res.status).toBe(200);
    expect(lastProxyCall).toMatchObject({
      accountId: ACCOUNT_ID,
      app: 'slack',
      providerAccountId: 'apn_slack_123',
    });
    expect(touchedConnectorIds).toEqual([CONNECTOR_ID]);
    expect(await res.json()).toMatchObject({ status: 200, body: { ok: true } });
  });

  test('runs provider actions without exposing raw OAuth tokens to the sandbox', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/connectors/run-action', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connector_id: CONNECTOR_ID,
        action_key: 'slack-send-message',
        props: { text: 'hello' },
      }),
    });

    expect(res.status).toBe(200);
    expect(lastRunActionCall).toMatchObject({
      accountId: ACCOUNT_ID,
      actionKey: 'slack-send-message',
      app: 'slack',
      providerAccountId: 'apn_slack_123',
    });
    const body = await res.json();
    expect(body.access_token).toBeUndefined();
    expect(body).toMatchObject({ success: true, result: { ok: true } });
  });
});
