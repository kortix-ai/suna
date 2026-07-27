import { describe, expect, test } from 'bun:test';
import { accountGithubInstallations, projectGitConnections } from '@kortix/db';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {
  NangoClient,
  NangoConnection,
  NangoConnectionSummary,
} from '../projects/nango/client';
import { githubReconnectRequired } from '../projects/nango/errors';
import {
  type GithubNangoConnectionStore,
  type StoredGithubNangoConnection,
  createGithubNangoConnectionStore,
  createGithubNangoConnectionsApp,
} from '../projects/routes/github-nango-connections';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const OUTSIDER_ID = '00000000-0000-4000-a000-000000000002';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-a000-000000000102';
const INSTALLATION_ID = '84';
const CONNECTION_ID = 'nango-connection-1';
const INTEGRATION_ID = 'github-account';

function storedConnection(
  overrides: Partial<StoredGithubNangoConnection> = {},
): StoredGithubNangoConnection {
  const now = new Date('2026-07-27T17:00:00.000Z');
  return {
    installationRowId: '00000000-0000-4000-a000-000000000041',
    accountId: ACCOUNT_ID,
    installationId: INSTALLATION_ID,
    nangoConnectionId: CONNECTION_ID,
    nangoIntegrationId: INTEGRATION_ID,
    connectionStatus: 'connected',
    lastValidatedAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    disconnectedAt: null,
    ownerLogin: 'acme',
    ownerType: 'Organization',
    repositorySelection: 'all',
    permissions: { contents: 'write' },
    metadata: {
      html_url: 'https://github.com/organizations/acme/settings/installations/84',
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function nangoConnection(): NangoConnection {
  return {
    id: 1,
    connectionId: CONNECTION_ID,
    integrationId: INTEGRATION_ID,
    provider: 'github-app-oauth',
    errors: [],
    metadata: {},
    connectionConfig: { installation_id: INSTALLATION_ID },
    tags: {},
    credentials: {
      type: 'CUSTOM',
      app: {
        type: 'APP',
        access_token: 'ghs_installation_secret',
        raw: {},
      },
      user: {
        type: 'OAUTH2',
        access_token: 'ghu_user_secret',
        raw: {},
      },
      raw: {},
    },
  };
}

function makeHarness(
  input: {
    row?: StoredGithubNangoConnection | null;
    canCreate?: boolean;
    canManage?: boolean;
    getConnectionError?: Error;
  } = {},
) {
  let row = input.row === undefined ? storedConnection() : input.row;
  const connectCalls: unknown[] = [];
  const reconnectCalls: unknown[] = [];
  const getCalls: unknown[] = [];
  const deleteCalls: unknown[] = [];
  const listCalls: string[] = [];
  const stateTransitions: Array<{ operation: string; input: unknown }> = [];

  const store: GithubNangoConnectionStore = {
    list: async (accountId) => {
      listCalls.push(accountId);
      return row && row.accountId === accountId ? [row] : [];
    },
    get: async (accountId, installationId) =>
      row && row.accountId === accountId && row.installationId === installationId ? row : null,
    markConnected: async (connection) => {
      stateTransitions.push({ operation: 'connected', input: connection });
      row = {
        ...connection,
        connectionStatus: 'connected',
        lastErrorCode: null,
        lastErrorMessage: null,
        disconnectedAt: null,
      };
      return row;
    },
    markNeedsReconnect: async (connection) => {
      stateTransitions.push({ operation: 'needs_reconnect', input: connection });
      row = {
        ...connection,
        connectionStatus: 'needs_reconnect',
        lastErrorCode: 'github_reconnect_required',
      };
      return row;
    },
    disconnect: async (connection) => {
      stateTransitions.push({ operation: 'disconnected', input: connection });
      row = {
        ...connection,
        connectionStatus: 'disconnected',
        disconnectedAt: new Date('2026-07-27T18:00:00.000Z'),
      };
      return row;
    },
  };

  const client: NangoClient = {
    createConnectSession: async (request) => {
      connectCalls.push(request);
      return {
        token: 'connect-session-token',
        expiresAt: '2026-07-27T18:00:00.000Z',
        connectLink: 'https://connect.nango.dev/session',
      };
    },
    createReconnectSession: async (request) => {
      reconnectCalls.push(request);
      return {
        token: 'reconnect-session-token',
        expiresAt: '2026-07-27T18:00:00.000Z',
        connectLink: 'https://connect.nango.dev/reconnect',
      };
    },
    listConnections: async (): Promise<NangoConnectionSummary[]> => [],
    getConnection: async (request) => {
      getCalls.push(request);
      if (input.getConnectionError) throw input.getConnectionError;
      return nangoConnection();
    },
    deleteConnection: async (request) => {
      deleteCalls.push(request);
    },
  };

  const routes = createGithubNangoConnectionsApp({
    client,
    store,
    accountIntegrationId: INTEGRATION_ID,
    webhookUrlOverride: 'https://local-tunnel.example/v1/webhooks/nango',
    createAttemptId: () => '00000000-0000-4000-a000-000000000901',
    resolveAccount: async (_context, body) => ({
      userId: USER_ID,
      accountId: String(body?.account_id ?? ACCOUNT_ID),
    }),
    authorize: async ({ action }) => {
      if (
        (action === 'project.create' && input.canCreate === false) ||
        (action === 'account.write' && input.canManage === false)
      ) {
        throw new HTTPException(403, { message: 'Forbidden' });
      }
    },
  });
  const app = new Hono();
  app.route('/v1/projects/github', routes);
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: error.message }, error.status);
    }
    return context.json({ error: (error as Error).message }, 500);
  });

  return {
    app,
    connectCalls,
    reconnectCalls,
    getCalls,
    deleteCalls,
    listCalls,
    stateTransitions,
    currentRow: () => row,
  };
}

describe('GitHub Nango connection routes', () => {
  test('creates an account-scoped Connect session with server-owned tags', async () => {
    const harness = makeHarness();
    const response = await harness.app.request('/v1/projects/github/connect-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        user_id: OUTSIDER_ID,
        tags: {
          kortix_account_id: OTHER_ACCOUNT_ID,
          kortix_user_id: OUTSIDER_ID,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'connect-session-token',
      expires_at: '2026-07-27T18:00:00.000Z',
      connect_link: 'https://connect.nango.dev/session',
    });
    expect(harness.connectCalls).toEqual([
      {
        integrationId: INTEGRATION_ID,
        tags: {
          kortix_account_id: ACCOUNT_ID,
          kortix_user_id: USER_ID,
          kortix_purpose: 'account',
          kortix_display_name: ACCOUNT_ID,
          kortix_connect_attempt_id: '00000000-0000-4000-a000-000000000901',
        },
        webhookUrlOverride: 'https://local-tunnel.example/v1/webhooks/nango',
      },
    ]);
  });

  test('denies Connect session creation without project-create permission', async () => {
    const harness = makeHarness({ canCreate: false });

    const response = await harness.app.request('/v1/projects/github/connect-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID }),
    });

    expect(response.status).toBe(403);
    expect(harness.connectCalls).toEqual([]);
  });

  test('reconnects the stored Nango connection and hides another account installation', async () => {
    const harness = makeHarness();

    const reconnect = await harness.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}/reconnect-session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: ACCOUNT_ID }),
      },
    );
    const hidden = await harness.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}/reconnect-session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: OTHER_ACCOUNT_ID }),
      },
    );

    expect(reconnect.status).toBe(200);
    expect(harness.reconnectCalls).toEqual([
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        integrationId: INTEGRATION_ID,
      }),
    ]);
    expect(hidden.status).toBe(404);
  });

  test('returns deterministic connection and reconnect guidance', async () => {
    const missing = makeHarness({
      row: storedConnection({
        nangoConnectionId: null,
        nangoIntegrationId: null,
        connectionStatus: null,
      }),
    });
    const unhealthy = makeHarness({
      row: storedConnection({ connectionStatus: 'needs_reconnect' }),
    });

    const missingResponse = await missing.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}/refresh`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: ACCOUNT_ID }),
      },
    );
    const unhealthyResponse = await unhealthy.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}/refresh`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: ACCOUNT_ID }),
      },
    );

    expect(missingResponse.status).toBe(409);
    expect(await missingResponse.json()).toMatchObject({
      code: 'github_connection_required',
      account_id: ACCOUNT_ID,
      installation_id: INSTALLATION_ID,
      requires_human_oauth: true,
      sdk_action: 'createGitHubConnectSession',
    });
    expect(unhealthyResponse.status).toBe(409);
    expect(await unhealthyResponse.json()).toMatchObject({
      code: 'github_reconnect_required',
      sdk_action: 'createGitHubReconnectSession',
    });
    expect(missing.getCalls).toEqual([]);
    expect(unhealthy.getCalls).toEqual([]);
  });

  test('refreshes healthy state without exposing the fresh credential', async () => {
    const harness = makeHarness();

    const response = await harness.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}/refresh`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: ACCOUNT_ID }),
      },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(harness.getCalls).toEqual([
      {
        connectionId: CONNECTION_ID,
        integrationId: INTEGRATION_ID,
        forceRefresh: true,
      },
    ]);
    expect(payload).toMatchObject({
      connection_id: CONNECTION_ID,
      connection_status: 'connected',
      reconnect_required: false,
    });
    expect(JSON.stringify(payload)).not.toContain('ghu_user_secret');
    expect(JSON.stringify(payload)).not.toContain('ghs_installation_secret');
  });

  test('returns reconnect guidance when credential refresh rejects authorization', async () => {
    const harness = makeHarness({
      getConnectionError: githubReconnectRequired(401),
    });

    const response = await harness.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}/refresh`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: ACCOUNT_ID }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'github_reconnect_required',
      account_id: ACCOUNT_ID,
      installation_id: INSTALLATION_ID,
      requires_human_oauth: true,
      sdk_action: 'createGitHubReconnectSession',
    });
    expect(harness.stateTransitions).toEqual([
      {
        operation: 'needs_reconnect',
        input: expect.objectContaining({
          accountId: ACCOUNT_ID,
          installationId: INSTALLATION_ID,
        }),
      },
    ]);
  });

  test('disconnects Nango access and preserves installation metadata', async () => {
    const harness = makeHarness();

    const response = await harness.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}?account_id=${ACCOUNT_ID}`,
      { method: 'DELETE' },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(harness.deleteCalls).toEqual([
      {
        connectionId: CONNECTION_ID,
        integrationId: INTEGRATION_ID,
      },
    ]);
    expect(harness.stateTransitions).toEqual([
      {
        operation: 'disconnected',
        input: expect.objectContaining({
          accountId: ACCOUNT_ID,
          installationId: INSTALLATION_ID,
          ownerLogin: 'acme',
        }),
      },
    ]);
    expect(payload).toMatchObject({
      ok: true,
      installation_id: INSTALLATION_ID,
      owner_login: 'acme',
      connection_status: 'disconnected',
      reconnect_required: true,
    });
    expect(harness.currentRow()?.ownerLogin).toBe('acme');
  });

  test('preserves camel-case legacy delete input without disconnecting every installation', async () => {
    const harness = makeHarness();

    const response = await harness.app.request(
      `/v1/projects/github/installation?account_id=${ACCOUNT_ID}&installationId=${INSTALLATION_ID}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(harness.listCalls).toEqual([]);
    expect(harness.deleteCalls).toHaveLength(1);
  });

  test('keeps installation-path disconnect idempotent for a missing row', async () => {
    const harness = makeHarness({ row: null });

    const response = await harness.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}?account_id=${ACCOUNT_ID}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(harness.deleteCalls).toEqual([]);
    expect(harness.stateTransitions).toEqual([]);
  });

  test('keeps installation-path disconnect idempotent for an already disconnected row', async () => {
    const harness = makeHarness({
      row: storedConnection({
        connectionStatus: 'disconnected',
        disconnectedAt: new Date('2026-07-27T18:00:00.000Z'),
      }),
    });

    const response = await harness.app.request(
      `/v1/projects/github/installations/${INSTALLATION_ID}?account_id=${ACCOUNT_ID}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      installation_id: INSTALLATION_ID,
      connection_status: 'disconnected',
    });
    expect(harness.deleteCalls).toEqual([]);
    expect(harness.stateTransitions).toEqual([]);
  });
});

describe('GitHub Nango connection persistence', () => {
  test('disconnect updates installation and project health without deleting metadata', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const original = storedConnection();
    const disconnected = {
      ...original,
      connectionStatus: 'disconnected',
      disconnectedAt: new Date('2026-07-27T18:00:00.000Z'),
    };
    const transaction = {
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updates.push({ table, values });
            const result = table === accountGithubInstallations ? [disconnected] : [];
            return Object.assign(Promise.resolve(result), {
              returning: async () => result,
            });
          },
        }),
      }),
    };
    const database = {
      transaction: async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    } as unknown as Parameters<typeof createGithubNangoConnectionStore>[0];
    const store = createGithubNangoConnectionStore(database);

    const result = await store.disconnect(original);

    expect(result).toMatchObject({
      installationId: INSTALLATION_ID,
      ownerLogin: 'acme',
      connectionStatus: 'disconnected',
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      table: accountGithubInstallations,
      values: {
        connectionStatus: 'disconnected',
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    expect(updates[1]).toMatchObject({
      table: projectGitConnections,
      values: {
        status: 'disconnected',
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    expect(updates[0]?.values).not.toHaveProperty('ownerLogin');
    expect(updates[1]?.values).not.toHaveProperty('repoUrl');
  });
});
