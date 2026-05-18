import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountMembers,
  projectConnectionTools,
  projectConnections,
  projectMembers,
  projectSessions,
  projects,
} from '@kortix/db';
import { encodeExecutorMcpSessionToken } from '@kortix/executor-bridge';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = 'executor-session-test';

let connectionRows: Array<typeof projectConnections.$inferSelect> = [];
let toolRows: Array<typeof projectConnectionTools.$inferSelect> = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Executor Bridge Test',
  repoUrl: 'https://github.com/kortix/test',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const sessionRow: typeof projectSessions.$inferSelect = {
  sessionId: SESSION_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  branchName: SESSION_ID,
  baseRef: 'main',
  sandboxProvider: 'local_docker',
  sandboxId: null,
  sandboxUrl: null,
  opencodeSessionId: null,
  agentName: 'default',
  status: 'running',
  error: null,
  metadata: {},
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function resetState() {
  connectionRows = [];
  toolRows = [];
  fetchCalls = [];
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'executor@example.test');
    await next();
  },
  apiKeyAuth: async (_c: any, next: any) => next(),
  combinedAuth: async (_c: any, next: any) => next(),
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: async () => {
            if (table === projectConnections) return connectionRows;
            if (table === projectConnectionTools) return toolRows;
            return [];
          },
          limit: async () => {
            if (table === projects) return [projectRow];
            if (table === accountMembers) {
              return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            }
            if (table === projectMembers) return [];
            if (table === projectSessions) return [sessionRow];
            if (table === projectConnections) return connectionRows.slice(0, 1);
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        returning: async () => {
          if (table === projectConnections) {
            const row: typeof projectConnections.$inferSelect = {
              connectionId: '44444444-4444-4444-8444-444444444444',
              accountId: values.accountId,
              projectId: values.projectId,
              name: values.name,
              sourceType: values.sourceType,
              config: values.config ?? {},
              enabled: values.enabled ?? true,
              createdBy: values.createdBy ?? USER_ID,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: values.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
            };
            connectionRows = [row];
            return [row];
          }
          if (table === projectConnectionTools) {
            const row: typeof projectConnectionTools.$inferSelect = {
              toolId: '55555555-5555-4555-8555-555555555555',
              connectionId: values.connectionId,
              accountId: values.accountId,
              projectId: values.projectId,
              name: values.name,
              description: values.description ?? null,
              inputSchema: values.inputSchema ?? {},
              implementation: values.implementation ?? {},
              enabled: values.enabled ?? true,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: values.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
            };
            toolRows = [row];
            return [row];
          }
          return [];
        },
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
  },
}));

const { projectsApp } = await import('../projects/index');
const { sessionMcp } = await import('../router/routes/session-mcp');
const { config } = await import('../config');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.route('/v1/router/mcp', sessionMcp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('Executor bridge project sources + session MCP', () => {
  beforeEach(() => resetState());

  test('creates a project tool and exposes it over the session MCP route', async () => {
    const app = createApp();

    const created = await app.request(`/v1/projects/${PROJECT_ID}/executor/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Demo tools',
        source_type: 'static',
        tool_name: 'Demo Echo',
        tool_description: 'Echoes arguments',
      }),
    });

    expect(created.status).toBe(201);
    const createdJson = await created.json();
    expect(createdJson.tools[0].name).toBe('demo_echo');

    const listed = await app.request(`/v1/projects/${PROJECT_ID}/executor/sources`);
    expect(listed.status).toBe(200);
    expect((await listed.json()).items[0].tools[0].name).toBe('demo_echo');

    const token = encodeExecutorMcpSessionToken({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      userId: USER_ID,
    }, config.API_KEY_SECRET);

    const toolsList = await app.request('/v1/router/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(toolsList.status).toBe(200);
    const toolsListJson = await toolsList.json();
    expect(toolsListJson.result.tools[0].name).toBe('demo_echo');

    const called = await app.request('/v1/router/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'demo_echo', arguments: { ok: true } },
      }),
    });
    expect(called.status).toBe(200);
    const calledJson = await called.json();
    expect(calledJson.result.structuredContent).toEqual({
      tool: 'demo_echo',
      arguments: { ok: true },
    });
  });

  test('proxies an Executor OpenAPI source through the session MCP route', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const app = createApp();

      const created = await app.request(`/v1/projects/${PROJECT_ID}/executor/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Stripe',
          source_type: 'openapi',
          config: {
            url: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
            base_url: 'https://api.stripe.com/v1',
            headers: { Authorization: 'Bearer test-token' },
          },
          tool_name: 'stripe.request',
          tool_description: 'Calls Stripe through the Executor HTTP proxy',
          implementation: { kind: 'http_proxy' },
        }),
      });

      expect(created.status).toBe(201);

      const token = encodeExecutorMcpSessionToken({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        userId: USER_ID,
      }, config.API_KEY_SECRET);

      const called = await app.request('/v1/router/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'stripe.request',
            arguments: {
              method: 'GET',
              path: '/customers',
              query: { limit: 1 },
            },
          },
        }),
      });

      expect(called.status).toBe(200);
      const calledJson = await called.json();
      expect(calledJson.result.structuredContent.status).toBe(200);
      expect(fetchCalls[0].url).toBe('https://api.stripe.com/v1/customers?limit=1');
      expect((fetchCalls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns a Pipedream Connect Link URL scoped to the selected app', async () => {
    const originalFetch = globalThis.fetch;
    const originalClientId = process.env.PIPEDREAM_CLIENT_ID;
    const originalClientSecret = process.env.PIPEDREAM_CLIENT_SECRET;
    const originalProjectId = process.env.PIPEDREAM_PROJECT_ID;
    process.env.PIPEDREAM_CLIENT_ID = 'pd-client';
    process.env.PIPEDREAM_CLIENT_SECRET = 'pd-secret';
    process.env.PIPEDREAM_PROJECT_ID = 'proj_test';

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).endsWith('/v1/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'pd-access', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        token: 'ctok_00000000000000000000000000000000',
        expires_at: '2026-01-01T04:00:00Z',
        connect_link_url: 'https://pipedream.com/_static/connect.html?token=ctok_00000000000000000000000000000000&connectLink=true',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const app = createApp();
      const res = await app.request(`/v1/projects/${PROJECT_ID}/executor/apps/slack/connect-token`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.connectUrl).toContain('app=slack');
      expect(fetchCalls[1].url).toBe('https://api.pipedream.com/v1/connect/proj_test/tokens');
    } finally {
      globalThis.fetch = originalFetch;
      process.env.PIPEDREAM_CLIENT_ID = originalClientId;
      process.env.PIPEDREAM_CLIENT_SECRET = originalClientSecret;
      process.env.PIPEDREAM_PROJECT_ID = originalProjectId;
    }
  });
});
