import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountGithubInstallations,
  accountMembers,
  projectChannelEvents,
  projectChannels,
  projectConnectors,
  projectMembers,
  projectSecrets,
  projectSessions,
  projects,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const CHANNEL_ID = '00000000-0000-4000-a000-000000000301';
const EVENT_ID = '00000000-0000-4000-a000-000000000401';
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
    scopes: ['channels:history', 'chat:write'],
    account_id_path: 'team.id',
    account_name_path: 'team.name',
  },
});

let channelRows: Array<typeof projectChannels.$inferSelect>;
let eventRows: Array<typeof projectChannelEvents.$inferSelect>;
let sessionRows: Array<typeof projectSessions.$inferSelect>;
let connectorRows: Array<typeof projectConnectors.$inferSelect>;
let secretRows: Array<typeof projectSecrets.$inferSelect>;
let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let provisioningSessionCount = 0;
let activeSessionCount = 0;
let lastProvisionEnv: Record<string, string> | null = null;
let providerConnectTokenCalls: Array<{
  accountId: string;
  app?: string;
  successRedirectUri: string;
  errorRedirectUri: string;
}> = [];

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Channel Project',
  repoUrl: 'https://github.com/kortix-ai/channel-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function channelRow(overrides: Partial<typeof projectChannels.$inferSelect> = {}): typeof projectChannels.$inferSelect {
  return {
    channelId: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    platform: 'slack',
    externalChannelId: 'C123',
    externalTeamId: 'T123',
    name: 'engineering',
    config: { secret: 'channel-secret' },
    agentName: 'default',
    promptTemplate: 'Slack says: {{ message.text }}',
    enabled: true,
    status: 'active',
    createdBy: USER_ID,
    metadata: {},
    lastMessageAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function connectorRow(overrides: Partial<typeof projectConnectors.$inferSelect> = {}): typeof projectConnectors.$inferSelect {
  return {
    connectorId: CONNECTOR_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    providerName: 'slack',
    app: 'slack',
    appName: 'Slack',
    providerAccountId: 'T_DIRECT',
    label: 'Direct Channel Team',
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
  channelRows = [];
  eventRows = [];
  sessionRows = [];
  connectorRows = [];
  secretRows = [];
  branchCreateCalls = 0;
  sandboxProvisionCalls = 0;
  provisioningSessionCount = 0;
  activeSessionCount = 0;
  lastProvisionEnv = null;
  providerConnectTokenCalls = [];
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    access_token: 'xoxb-channel-direct',
    token_type: 'bearer',
    expires_in: 3600,
    team: { id: 'T_DIRECT', name: 'Direct Channel Team' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as any;
}

function sign(rawBody: string, secret = 'channel-secret') {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'channels@example.test');
    await next();
  },
}));

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
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
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: {},
  }),
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async (input: any) => {
    sandboxProvisionCalls += 1;
    lastProvisionEnv = input.extraEnvVars;
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'channels@example.test' } } }),
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'free' }),
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
        token: 'channel-connect-token',
        expiresAt: '2026-01-02T00:00:00Z',
        connectUrl: 'https://pipedream.com/connect/channel-test',
      };
    },
  }),
}));

mock.module('../shared/db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const result: any[] & { orderBy?: () => Promise<any[]>; limit?: () => Promise<any[]> } = [];
          result.orderBy = async () => {
            if (table === projectChannels) return channelRows;
            if (table === projectChannelEvents) return eventRows;
            if (table === projectConnectors) return connectorRows;
            if (table === projectSecrets) return [];
            if (table === projectSessions) return sessionRows;
            return [];
          };
          result.limit = async () => {
            if (fields && Object.keys(fields).includes('activeCount')) {
              return [{ activeCount: activeSessionCount }];
            }
            if (fields && Object.keys(fields).includes('provisioningCount')) {
              return [{ provisioningCount: provisioningSessionCount }];
            }
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            if (table === accountGithubInstallations) return [];
            if (table === projectMembers) return [];
            if (table === projectChannels) return channelRows.slice(0, 1);
            if (table === projectConnectors) return connectorRows.slice(0, 1);
            if (table === projectSessions) return sessionRows.slice(0, 1);
            return [];
          };
          return result;
        },
        orderBy: async () => {
          if (table === projectChannels) return channelRows;
          if (table === projectChannelEvents) return eventRows;
          if (table === projectConnectors) return connectorRows;
          if (table === projectSessions) return sessionRows;
          return [];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoUpdate: ({ set }: { set: Partial<typeof projectChannels.$inferInsert> }) => ({
          returning: async () => {
            if (table === projectConnectors) {
              const existingIndex = connectorRows.findIndex((row) =>
                row.projectId === values.projectId &&
                row.providerName === values.providerName &&
                row.providerAccountId === values.providerAccountId,
              );
              const now = new Date('2026-01-02T00:00:00Z');
              const row = connectorRow({
                connectorId: existingIndex >= 0 ? connectorRows[existingIndex]!.connectorId : values.connectorId ?? CONNECTOR_ID,
                accountId: values.accountId,
                projectId: values.projectId,
                providerName: values.providerName ?? 'pipedream',
                app: (set as any).app ?? values.app,
                appName: ((set as any).appName ?? values.appName) as string | null,
                providerAccountId: values.providerAccountId,
                label: ((set as any).label ?? values.label) as string | null,
                status: ((set as any).status ?? values.status ?? 'active') as any,
                scopes: ((set as any).scopes ?? values.scopes ?? []) as string[],
                metadata: ((set as any).metadata ?? values.metadata ?? {}) as Record<string, unknown>,
                createdBy: values.createdBy ?? null,
                updatedAt: ((set as any).updatedAt ?? values.updatedAt ?? now) as Date,
              });
              if (existingIndex >= 0) connectorRows[existingIndex] = row;
              else connectorRows.push(row);
              return [row];
            }
            if (table === projectSecrets) {
              const existingIndex = secretRows.findIndex((row) => row.projectId === values.projectId && row.name === values.name);
              const now = new Date('2026-01-02T00:00:00Z');
              const row: typeof projectSecrets.$inferSelect = {
                secretId: existingIndex >= 0 ? secretRows[existingIndex]!.secretId : values.secretId ?? SECRET_ID,
                projectId: values.projectId,
                name: values.name,
                valueEnc: ((set as any).valueEnc ?? values.valueEnc) as string,
                createdBy: values.createdBy ?? null,
                createdAt: existingIndex >= 0 ? secretRows[existingIndex]!.createdAt : now,
                updatedAt: ((set as any).updatedAt ?? values.updatedAt ?? now) as Date,
              };
              if (existingIndex >= 0) secretRows[existingIndex] = row;
              else secretRows.push(row);
              return [row];
            }
            if (table !== projectChannels) return [];
            const existingIndex = channelRows.findIndex((row) =>
              row.projectId === values.projectId &&
              row.platform === values.platform &&
              row.externalChannelId === values.externalChannelId,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row = channelRow({
              channelId: existingIndex >= 0 ? channelRows[existingIndex]!.channelId : values.channelId ?? CHANNEL_ID,
              accountId: values.accountId,
              projectId: values.projectId,
              platform: values.platform,
              externalChannelId: values.externalChannelId,
              externalTeamId: (set.externalTeamId ?? values.externalTeamId) as string | null,
              name: (set.name ?? values.name) as string | null,
              config: (set.config ?? values.config ?? {}) as Record<string, unknown>,
              agentName: (set.agentName ?? values.agentName ?? 'default') as string,
              promptTemplate: (set.promptTemplate ?? values.promptTemplate) as string,
              enabled: (set.enabled ?? values.enabled ?? true) as boolean,
              status: (set.status ?? values.status ?? 'active') as any,
              metadata: (set.metadata ?? values.metadata ?? {}) as Record<string, unknown>,
              createdBy: values.createdBy ?? null,
              createdAt: existingIndex >= 0 ? channelRows[existingIndex]!.createdAt : now,
              updatedAt: (set.updatedAt ?? values.updatedAt ?? now) as Date,
            });
            if (existingIndex >= 0) channelRows[existingIndex] = row;
            else channelRows.push(row);
            return [row];
          },
        }),
        returning: async () => {
          const now = new Date('2026-01-02T00:00:00Z');
          if (table === projectChannelEvents) {
            const row: typeof projectChannelEvents.$inferSelect = {
              eventId: values.eventId ?? `${EVENT_ID.slice(0, -1)}${eventRows.length + 1}`,
              channelId: values.channelId,
              accountId: values.accountId,
              projectId: values.projectId,
              platform: values.platform,
              externalMessageId: values.externalMessageId ?? null,
              status: values.status ?? 'queued',
              payload: values.payload ?? {},
              renderedPrompt: values.renderedPrompt ?? null,
              sessionId: values.sessionId ?? null,
              error: values.error ?? null,
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            eventRows.push(row);
            return [row];
          }
          if (table === projectSessions) {
            const row: typeof projectSessions.$inferSelect = {
              sessionId: values.sessionId,
              accountId: values.accountId,
              projectId: values.projectId,
              branchName: values.branchName,
              baseRef: values.baseRef,
              sandboxProvider: values.sandboxProvider,
              sandboxId: values.sandboxId,
              sandboxUrl: null,
              opencodeSessionId: null,
              agentName: values.agentName,
              status: values.status,
              error: null,
              metadata: values.metadata ?? {},
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            sessionRows.push(row);
            return [row];
          }
          return [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: any) => ({
        where: () => ({
          returning: async () => {
            if (table === projectChannels) {
              if (channelRows.length === 0) return [];
              channelRows[0] = {
                ...channelRows[0]!,
                ...updates,
                updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
              };
              return [channelRows[0]];
            }
            if (table === projectChannelEvents) {
              if (eventRows.length === 0) return [];
              eventRows[0] = {
                ...eventRows[0]!,
                ...updates,
                updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
              };
              return [eventRows[0]];
            }
            if (table === projectSessions && sessionRows.length > 0) {
              sessionRows[0] = { ...sessionRows[0]!, ...updates };
              return [sessionRows[0]];
            }
            return [];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectChannels) channelRows = [];
      },
    }),
  },
}));

const { projectChannelsApp, projectConnectorOAuthApp, projectsApp } = await import('../projects/index');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.route('/v1/channels', projectChannelsApp);
  app.route('/v1/connectors/oauth', projectConnectorOAuthApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('project channels API contract', () => {
  beforeEach(() => resetState());

  test('creates provider connect token for channel installs', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/channels/connect-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'slack',
        app: 'slack',
        success_redirect_uri: 'https://app.example.com/channel-success',
        error_redirect_uri: 'https://app.example.com/channel-error',
      }),
    });

    expect(res.status).toBe(200);
    expect(providerConnectTokenCalls).toEqual([{
      accountId: ACCOUNT_ID,
      app: 'slack',
      successRedirectUri: 'https://app.example.com/channel-success',
      errorRedirectUri: 'https://app.example.com/channel-error',
    }]);
    const body = await res.json();
    expect(body).toMatchObject({
      token: 'channel-connect-token',
      expiresAt: '2026-01-02T00:00:00Z',
      connectUrl: 'https://pipedream.com/connect/channel-test',
    });
  });

  test('starts and completes direct OAuth-backed chat app installs cloud-side', async () => {
    const app = createApp();
    const startRes = await app.request(`/v1/projects/${PROJECT_ID}/channels/oauth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'slack',
        success_redirect_uri: 'https://app.example.com/channels/connected',
        error_redirect_uri: 'https://app.example.com/channels/error',
      }),
    });

    expect(startRes.status).toBe(200);
    const startBody = await startRes.json();
    expect(startBody).toMatchObject({
      provider: 'slack',
      app: 'slack',
      surface: 'channel',
    });
    const authorizationUrl = new URL(startBody.authorization_url);
    expect(authorizationUrl.origin).toBe('https://slack.example');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('direct-client');
    expect(authorizationUrl.searchParams.get('scope')).toBe('channels:history chat:write');
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const callbackRes = await app.request(`/v1/connectors/oauth/callback?code=oauth-code&state=${encodeURIComponent(state!)}`);
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get('location');
    expect(location).toContain('https://app.example.com/channels/connected');
    expect(location).toContain('direct_oauth=connected');
    expect(location).toContain('surface=channel');
    expect(location).toContain('provider_account_id=T_DIRECT');

    // OAuth tokens are never persisted to project_secrets — secrets are user-managed only.
    expect(secretRows).toHaveLength(0);
    expect(connectorRows).toHaveLength(1);
    expect(connectorRows[0]).toMatchObject({
      providerName: 'slack',
      app: 'slack',
      appName: 'Slack',
      providerAccountId: 'T_DIRECT',
      label: 'Direct Channel Team',
      metadata: {
        direct_oauth: true,
        surface: 'channel',
        user_info_present: false,
      },
    });
    expect(channelRows).toHaveLength(0);
  });

  test('creates, lists, patches, and deletes channels without echoing secrets', async () => {
    const app = createApp();
    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'slack',
        external_channel_id: 'C123',
        external_team_id: 'T123',
        name: 'engineering',
        config: { secret: 'channel-secret' },
        prompt_template: 'Slack says: {{ message.text }}',
      }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.config.secret).toBeUndefined();
    expect(created.config.has_secret).toBe(true);

    const listRes = await app.request(`/v1/projects/${PROJECT_ID}/channels`);
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toHaveLength(1);

    const patchRes = await app.request(`/v1/projects/${PROJECT_ID}/channels/${CHANNEL_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'product', enabled: false, metadata: { owner: 'ops' } }),
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({
      name: 'product',
      enabled: false,
      metadata: { owner: 'ops' },
    });

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/channels/${CHANNEL_ID}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(channelRows).toHaveLength(0);
  });

  test('reads a single channel and lists accepted channel events', async () => {
    channelRows.push(channelRow());
    eventRows.push({
      eventId: EVENT_ID,
      channelId: CHANNEL_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      platform: 'slack',
      externalMessageId: 'EvRead',
      status: 'fired',
      payload: { event: { text: 'already processed' } },
      renderedPrompt: 'Slack says: already processed',
      sessionId: '00000000-0000-4000-a000-000000000777',
      error: null,
      createdAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    });

    const app = createApp();
    const channelRes = await app.request(`/v1/projects/${PROJECT_ID}/channels/${CHANNEL_ID}`);
    expect(channelRes.status).toBe(200);
    expect(await channelRes.json()).toMatchObject({
      channel_id: CHANNEL_ID,
      config: { has_secret: true },
    });

    const eventsRes = await app.request(`/v1/projects/${PROJECT_ID}/channels/${CHANNEL_ID}/events`);
    expect(eventsRes.status).toBe(200);
    const events = await eventsRes.json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: EVENT_ID,
      status: 'fired',
      rendered_prompt: 'Slack says: already processed',
    });
  });

  test('rejects unsigned channel events before creating an event or branch', async () => {
    channelRows.push(channelRow());
    const app = createApp();
    const res = await app.request(`/v1/channels/slack/${CHANNEL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { text: 'do not run' } }),
    });

    expect(res.status).toBe(401);
    expect(eventRows).toHaveLength(0);
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('rejects channel events when no signing secret is configured', async () => {
    channelRows.push(channelRow({ config: {} }));
    const app = createApp();
    const rawBody = JSON.stringify({ event: { text: 'do not run' } });
    const res = await app.request(`/v1/channels/slack/${CHANNEL_ID}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody),
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Channel secret is not configured' });
    expect(eventRows).toHaveLength(0);
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('fires a signed Slack message through the normal session creation path', async () => {
    channelRows.push(channelRow());
    const app = createApp();
    const rawBody = JSON.stringify({ event_id: 'Ev1', event: { text: 'ship connectors', ts: '123.45' } });
    const res = await app.request(`/v1/channels/slack/${CHANNEL_ID}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody),
      },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('fired');
    expect(body.event.status).toBe('fired');
    expect(body.event.rendered_prompt).toBe('Slack says: ship connectors');
    expect(body.session.metadata).toMatchObject({
      channel_id: CHANNEL_ID,
      channel_platform: 'slack',
      initial_prompt: 'Slack says: ship connectors',
    });
    expect(branchCreateCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBe('Slack says: ship connectors');
    expect(lastProvisionEnv?.KORTIX_CONNECTOR_TOKEN).toBeTruthy();
  });

  test('queues channel events when project provisioning backpressure is saturated', async () => {
    channelRows.push(channelRow());
    provisioningSessionCount = 3;
    const app = createApp();
    const rawBody = JSON.stringify({ event_id: 'Ev2', event: { text: 'queue me', ts: '124.45' } });
    const res = await app.request(`/v1/channels/slack/${CHANNEL_ID}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody),
      },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.event.status).toBe('queued');
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });
});
