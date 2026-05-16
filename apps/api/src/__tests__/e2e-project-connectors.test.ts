import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectConnectors, projectMembers, projectSecrets, projects } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const CONNECTOR_ID = '00000000-0000-4000-a000-000000000501';
const SECRET_ID = '00000000-0000-4000-a000-000000000601';

process.env.KORTIX_DIRECT_OAUTH_APPS = JSON.stringify({
  slack: {
    provider: 'slack',
    app_name: 'Slack',
    authorization_url: 'https://slack.example/oauth/authorize',
    token_url: 'https://slack.example/oauth/token',
    client_id: 'direct-client',
    client_secret: 'direct-secret',
    scopes: ['chat:write'],
    account_id_path: 'team.id',
    account_name_path: 'team.name',
  },
});
process.env.KORTIX_OAUTH_RELAY_ALLOWED_ORIGINS = 'https://self-host.example.com';

let connectorRows: Array<typeof projectConnectors.$inferSelect> = [];
let secretRows: Array<typeof projectSecrets.$inferSelect> = [];
let providerGetAccountCalls: Array<{ accountId: string; providerAccountId: string }> = [];
let providerListAccountsCalls = 0;
let providerListAppsCalls: Array<{ query?: string; limit: number; cursor?: string }> = [];
let providerConnectTokenCalls: Array<{
  accountId: string;
  app?: string;
  successRedirectUri: string;
  errorRedirectUri: string;
}> = [];

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Connector Project',
  repoUrl: 'https://github.com/kortix-ai/connector-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function connector(overrides: Partial<typeof projectConnectors.$inferSelect> = {}): typeof projectConnectors.$inferSelect {
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

function resetState() {
  connectorRows = [];
  secretRows = [];
  providerGetAccountCalls = [];
  providerListAccountsCalls = 0;
  providerListAppsCalls = [];
  providerConnectTokenCalls = [];
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    access_token: 'xoxb-direct',
    token_type: 'bearer',
    expires_in: 3600,
    team: { id: 'T_DIRECT', name: 'Direct Team' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as any;
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'connectors@example.test');
    await next();
  },
}));

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => undefined,
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({}),
  readRepoFile: async () => '',
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  commitFile: async () => undefined,
  createInstallationToken: async () => ({ token: 'installation-token' }),
  createRepo: async () => {
    throw new Error('not used');
  },
  getFileSha: async () => null,
  getGitHubAppInstallation: async () => null,
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => undefined,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'connectors@example.test' } } }),
      },
    },
  }),
}));

mock.module('../integrations/providers', () => ({
  getProviderFromRequest: async () => ({
    name: 'pipedream',
    createConnectToken: async (
      accountId: string,
      app?: string,
      options?: { successRedirectUri: string; errorRedirectUri: string },
    ) => {
      providerConnectTokenCalls.push({
        accountId,
        app,
        successRedirectUri: options?.successRedirectUri ?? '',
        errorRedirectUri: options?.errorRedirectUri ?? '',
      });
      return {
      token: 'pd-connect-token',
      expiresAt: '2026-01-02T00:00:00Z',
      connectUrl: 'https://pipedream.com/connect/test',
      };
    },
    listApps: async (query?: string, limit = 48, cursor?: string) => {
      providerListAppsCalls.push({ query, limit, cursor });
      return {
      apps: [{ slug: 'slack', name: 'Slack', categories: ['communication'] }],
      pageInfo: { totalCount: 1, count: 1, hasMore: false },
      };
    },
    listAccounts: async () => {
      providerListAccountsCalls += 1;
      return [
        {
          id: 'apn_slack_123',
          app: 'slack',
          appName: 'Slack',
          externalUserId: ACCOUNT_ID,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'apn_linear_456',
          app: 'linear',
          appName: 'Linear',
          externalUserId: ACCOUNT_ID,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
    },
    getAccount: async (accountId: string, providerAccountId: string) => {
      providerGetAccountCalls.push({ accountId, providerAccountId });
      if (providerAccountId === 'apn_slack_123') {
        return {
          id: providerAccountId,
          app: 'slack',
          appName: 'Slack',
          externalUserId: accountId,
          createdAt: '2026-01-01T00:00:00Z',
        };
      }
      return null;
    },
  }),
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: async () => {
            if (table === projectConnectors) return connectorRows;
            return [];
          },
          limit: async () => {
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            if (table === projectMembers) return [];
            if (table === projectConnectors) return connectorRows.slice(0, 1);
            return [];
          },
        }),
        orderBy: async () => {
          if (table === projectConnectors) return connectorRows;
          return [];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoUpdate: ({ set }: { set: any }) => ({
          returning: async () => {
            const now = new Date('2026-01-02T00:00:00Z');
            if (table === projectConnectors) {
              const existingIndex = connectorRows.findIndex((row) =>
                row.projectId === values.projectId &&
                row.providerName === values.providerName &&
                row.providerAccountId === values.providerAccountId,
              );
              const row = connector({
                connectorId: existingIndex >= 0 ? connectorRows[existingIndex]!.connectorId : values.connectorId ?? CONNECTOR_ID,
                accountId: values.accountId,
                projectId: values.projectId,
                providerName: values.providerName ?? 'pipedream',
                app: set.app ?? values.app,
                appName: (set.appName ?? values.appName) as string | null,
                providerAccountId: values.providerAccountId,
                label: (set.label ?? values.label) as string | null,
                status: (set.status ?? values.status ?? 'active') as any,
                scopes: (set.scopes ?? values.scopes ?? []) as string[],
                metadata: (set.metadata ?? values.metadata ?? {}) as Record<string, unknown>,
                createdBy: values.createdBy ?? null,
                updatedAt: (set.updatedAt ?? values.updatedAt ?? now) as Date,
              });
              if (existingIndex >= 0) connectorRows[existingIndex] = row;
              else connectorRows.push(row);
              return [row];
            }
            if (table === projectSecrets) {
              const existingIndex = secretRows.findIndex((row) => row.projectId === values.projectId && row.name === values.name);
              const row: typeof projectSecrets.$inferSelect = {
                secretId: existingIndex >= 0 ? secretRows[existingIndex]!.secretId : values.secretId ?? SECRET_ID,
                projectId: values.projectId,
                name: values.name,
                valueEnc: (set.valueEnc ?? values.valueEnc) as string,
                createdBy: values.createdBy ?? null,
                createdAt: existingIndex >= 0 ? secretRows[existingIndex]!.createdAt : now,
                updatedAt: (set.updatedAt ?? values.updatedAt ?? now) as Date,
              };
              if (existingIndex >= 0) secretRows[existingIndex] = row;
              else secretRows.push(row);
              return [row];
            }
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Partial<typeof projectConnectors.$inferInsert>) => ({
        where: () => ({
          returning: async () => {
            if (table !== projectConnectors || connectorRows.length === 0) return [];
            const row = {
              ...connectorRows[0]!,
              ...updates,
              updatedAt: (updates.updatedAt as Date | undefined) ?? new Date('2026-01-02T00:00:00Z'),
            };
            connectorRows[0] = row;
            return [row];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectConnectors) connectorRows = [];
      },
    }),
  },
}));

const { projectConnectorOAuthApp, projectsApp } = await import('../projects/index');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.route('/v1/connectors/oauth', projectConnectorOAuthApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('project connector API', () => {
  beforeEach(() => resetState());

  test('lists connector apps through the account provider', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/connectors/apps?q=sla&limit=12&cursor=next`);

    expect(res.status).toBe(200);
    expect(providerListAppsCalls).toEqual([{ query: 'sla', limit: 12, cursor: 'next' }]);
    const body = await res.json();
    expect(body.apps).toEqual([{ slug: 'slack', name: 'Slack', categories: ['communication'] }]);
    expect(body.pageInfo).toMatchObject({ totalCount: 1, count: 1, hasMore: false });
  });

  test('creates provider connect token without creating a project connector row', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/connectors/connect-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'slack',
        success_redirect_uri: 'https://app.example.com/success',
        error_redirect_uri: 'https://app.example.com/error',
      }),
    });

    expect(res.status).toBe(200);
    expect(providerConnectTokenCalls).toEqual([{
      accountId: ACCOUNT_ID,
      app: 'slack',
      successRedirectUri: 'https://app.example.com/success',
      errorRedirectUri: 'https://app.example.com/error',
    }]);
    expect(connectorRows).toHaveLength(0);
    await expect(res.json()).resolves.toMatchObject({
      token: 'pd-connect-token',
      expiresAt: '2026-01-02T00:00:00Z',
      connectUrl: 'https://pipedream.com/connect/test',
    });
  });

  test('creates a project connector only after provider account verification', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'slack',
        provider_account_id: 'apn_slack_123',
        label: 'Company Slack',
      }),
    });

    expect(res.status).toBe(201);
    expect(providerGetAccountCalls).toEqual([{ accountId: ACCOUNT_ID, providerAccountId: 'apn_slack_123' }]);
    expect(connectorRows).toHaveLength(1);
    const body = await res.json();
    expect(body).toMatchObject({
      connector_id: CONNECTOR_ID,
      project_id: PROJECT_ID,
      provider: 'pipedream',
      app: 'slack',
      provider_account_id: 'apn_slack_123',
    });
  });

  test('rejects binding a provider account that does not belong to the account app', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'notion',
        provider_account_id: 'apn_slack_123',
      }),
    });

    expect(res.status).toBe(400);
    expect(connectorRows).toHaveLength(0);
  });

  test('sync imports provider accounts as project-scoped connectors', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/connectors/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'slack' }),
    });

    expect(res.status).toBe(200);
    expect(providerListAccountsCalls).toBe(1);
    expect(connectorRows).toHaveLength(1);
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.connectors[0]).toMatchObject({
      app: 'slack',
      provider_account_id: 'apn_slack_123',
    });
  });

  test('starts and completes direct OAuth without exposing provider tokens to the sandbox', async () => {
    const app = createApp();
    const startRes = await app.request(`/v1/projects/${PROJECT_ID}/connectors/oauth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'slack',
        success_redirect_uri: 'https://app.example.com/connected',
        error_redirect_uri: 'https://app.example.com/error',
      }),
    });

    expect(startRes.status).toBe(200);
    const startBody = await startRes.json();
    const authorizationUrl = new URL(startBody.authorization_url);
    expect(authorizationUrl.origin).toBe('https://slack.example');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('direct-client');
    expect(authorizationUrl.searchParams.get('scope')).toBe('chat:write');
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const callbackRes = await app.request(`/v1/connectors/oauth/callback?code=oauth-code&state=${encodeURIComponent(state!)}`);
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get('location');
    expect(location).toContain('https://app.example.com/connected');
    expect(location).toContain('direct_oauth=connected');
    expect(location).toContain('provider_account_id=T_DIRECT');

    // OAuth tokens are never persisted to project_secrets — secrets are user-managed only.
    expect(secretRows).toHaveLength(0);
    expect(connectorRows).toHaveLength(1);
    expect(connectorRows[0]).toMatchObject({
      providerName: 'slack',
      app: 'slack',
      appName: 'Slack',
      providerAccountId: 'T_DIRECT',
      label: 'Direct Team',
      metadata: {
        direct_oauth: true,
        surface: 'connector',
        user_info_present: false,
      },
    });
  });

  test('relays OAuth callbacks only to allowlisted self-host origins', async () => {
    const app = createApp();
    const allowed = await app.request('/v1/connectors/oauth/relay?target=https%3A%2F%2Fself-host.example.com%2Fv1%2Fconnectors%2Foauth%2Fcallback&code=abc&state=xyz');
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get('location')).toBe('https://self-host.example.com/v1/connectors/oauth/callback?code=abc&state=xyz');

    const denied = await app.request('/v1/connectors/oauth/relay?target=https%3A%2F%2Fevil.example.com%2Fcallback&code=abc&state=xyz');
    expect(denied.status).toBe(403);
  });

  test('lists, updates, and deletes project connectors through the project surface', async () => {
    connectorRows = [connector()];
    const app = createApp();

    const listRes = await app.request(`/v1/projects/${PROJECT_ID}/connectors`);
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toHaveLength(1);

    const getRes = await app.request(`/v1/projects/${PROJECT_ID}/connectors/${CONNECTOR_ID}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      connector_id: CONNECTOR_ID,
      project_id: PROJECT_ID,
      provider: 'pipedream',
      app: 'slack',
      provider_account_id: 'apn_slack_123',
    });

    const patchRes = await app.request(`/v1/projects/${PROJECT_ID}/connectors/${CONNECTOR_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed', status: 'revoked', metadata: { reason: 'rotated' } }),
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({
      label: 'Renamed',
      status: 'revoked',
      metadata: { reason: 'rotated' },
    });

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/connectors/${CONNECTOR_ID}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(connectorRows).toHaveLength(0);
  });
});
