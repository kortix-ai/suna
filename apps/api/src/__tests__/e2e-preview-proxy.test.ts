/**
 * E2E tests for the Daytona preview proxy.
 *
 * Tests: port validation, ownership verification, proxy forwarding,
 *        auto-wake for stopped/archived sandboxes, CORS, no-trailing-slash redirect.
 *
 * Strategy:
 * - mock.module() replaces auth, DB, Daytona SDK, and global fetch
 * - Auth is bypassed (userId injected directly)
 * - DB queries are mocked to simulate ownership checks
 * - Daytona SDK is mocked to return preview links
 * - Global fetch is mocked to simulate upstream responses
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { runWithContext } from '../lib/request-context';

// ─── Mock state ──────────────────────────────────────────────────────────────

const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';
const TEST_SANDBOX_ID = 'sandbox-abc-123';
const TEST_SESSION_SANDBOX_ID = '11111111-1111-4111-8111-111111111111';
const TEST_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const TEST_SERVICE_KEY = 'test-service-key-123';
const TEST_PORT = 8080;

let mockDbSandbox: any = {
  sandboxId: TEST_SESSION_SANDBOX_ID,
  projectId: TEST_PROJECT_ID,
  accountId: 'account-001',
  agentName: 'default',
  status: 'active',
  config: { serviceKey: TEST_SERVICE_KEY },
  provider: 'daytona',
  baseUrl: null,
};
let mockDbMembership: any = { accountRole: 'member' };
let mockPreviewUrl = 'https://preview.daytona.io/proxy-url';
let mockPreviewToken: string | null = 'daytona-preview-token-123';
let mockWakeCalls: string[] = [];
let mockFetchResponses: Array<{
  status: number;
  body: string;
  headers?: Record<string, string>;
  error?: Error;
}> = [];
let mockFetchCallCount = 0;
let mockFetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
let mockDbUpdateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
let mockResolvedPreviewPorts: number[] = [];

function mockSandboxRows(): any[] {
  if (!mockDbSandbox) return [];
  return Array.isArray(mockDbSandbox) ? mockDbSandbox : [mockDbSandbox];
}

function sortPreferredSandboxRows(rows: any[]): any[] {
  const rank = (status: string) => {
    if (status === 'active') return 0;
    if (status === 'provisioning') return 1;
    if (status === 'stopped') return 2;
    return 3;
  };
  return [...rows].sort((a, b) => {
    const statusDiff = rank(a.status) - rank(b.status);
    if (statusDiff !== 0) return statusDiff;
    return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
  });
}

// ─── Register mocks ──────────────────────────────────────────────────────────

// Auth mock — bypass combinedAuth
mock.module('../middleware/auth', () => ({
  combinedAuth: async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    const cookieHeader = c.req.header('Cookie') || '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)__preview_session=([^;]+)/);
    const hasCookie = !!cookieMatch;
    if (!authHeader?.startsWith('Bearer ') && !hasCookie) {
      throw new HTTPException(401, { message: 'Missing authentication token' });
    }
    c.set('userId', TEST_USER_ID);
    c.set('userEmail', 'test@kortix.dev');
    await next();
  },
  supabaseAuth: async (c: any, next: any) => { await next(); },
  apiKeyAuth: async (c: any, next: any) => { await next(); },
}));

// DB mock — simulate sandbox + membership queries
// Uses field-aware matching: inspects the `select` fields to determine which
// mock to return (accountId → sandbox table, accountRole → membership table).
// This is more resilient to query reordering than the old call-counter approach.
mock.module('../shared/db', () => {
  return {
    hasDatabase: true,
    db: {
      select: (fields: any) => {
        // Determine which table is being queried by inspecting selected fields
        // The preview proxy selects several session_sandboxes projections and
        // { accountRole } from accountUser/account_members depending on the path.
        const fieldKeys = fields ? Object.keys(fields) : [];
        const isSandboxQuery = fieldKeys.some((key) =>
          ['accountId', 'sandboxId', 'projectId', 'agentName', 'status', 'config', 'provider', 'baseUrl'].includes(key),
        );
        const isMembershipQuery = fieldKeys.includes('accountRole');
        const isProjectSessionQuery = fieldKeys.includes('createdBy');

        const rowsFor = (ordered = false): any[] => {
          if (isSandboxQuery) {
            const rows = mockSandboxRows();
            return ordered ? sortPreferredSandboxRows(rows) : rows;
          }
          if (isMembershipQuery) return mockDbMembership ? [mockDbMembership] : [];
          if (isProjectSessionQuery) return [{ createdBy: TEST_USER_ID, accountId: 'account-001' }];
          // Fallback: empty (unknown query, e.g. accountGroupMembers in
          // resolveShareSubject — the test models no group memberships).
          return [];
        };
        const queryFrom = () => ({
          innerJoin: () => queryFrom(),
          // `.where(...)` is both awaitable (resolveShareSubject awaits it
          // directly, expecting an array) and chainable via `.limit(n)`.
          where: () => {
              let ordered = false;
              const query = {
                orderBy: () => {
                  ordered = true;
                  return query;
                },
                limit: (n: number) => Promise.resolve(rowsFor(ordered).slice(0, n)),
                then: (resolve: (rows: any[]) => unknown, reject?: (reason: unknown) => unknown) =>
                  Promise.resolve(rowsFor(ordered)).then(resolve, reject),
              };
              return query;
          },
        });
        return { from: queryFrom };
      },
      update: (table: unknown) => ({
        set: (updates: Record<string, unknown>) => ({
          where: async () => {
            mockDbUpdateCalls.push({ table, updates });
          },
        }),
      }),
    },
  };
});

mock.module('../sandbox-proxy/effect', () => ({
  sandboxProxyConfig: {
    isDaytonaEnabled: () => true,
    isJustAVPSEnabled: () => false,
    ALLOWED_SANDBOX_PROVIDERS: ['daytona'],
  },
  sandboxProxyDb: {
    select: (fields: any) => {
      const fieldKeys = fields ? Object.keys(fields) : [];
      const isSandboxQuery = fieldKeys.some((key) =>
        ['accountId', 'sandboxId', 'projectId', 'agentName', 'status', 'config', 'provider', 'baseUrl'].includes(key),
      );
      const isMembershipQuery = fieldKeys.includes('accountRole');
      const isProjectSessionQuery = fieldKeys.includes('createdBy');
      const rowsFor = (ordered = false): any[] => {
        if (isSandboxQuery) {
          const rows = mockSandboxRows();
          return ordered ? sortPreferredSandboxRows(rows) : rows;
        }
        if (isMembershipQuery) return mockDbMembership ? [mockDbMembership] : [];
        if (isProjectSessionQuery) return [{ createdBy: TEST_USER_ID, accountId: 'account-001' }];
        return [];
      };
      const queryFrom = () => ({
        innerJoin: () => queryFrom(),
        where: () => {
            let ordered = false;
            const query = {
              orderBy: () => {
                ordered = true;
                return query;
              },
              limit: (n: number) => Promise.resolve(rowsFor(ordered).slice(0, n)),
              then: (resolve: (rows: any[]) => unknown, reject?: (reason: unknown) => unknown) =>
                Promise.resolve(rowsFor(ordered)).then(resolve, reject),
            };
            return query;
        },
      });
      return { from: queryFrom };
    },
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: async () => {
          mockDbUpdateCalls.push({ table, updates });
        },
      }),
    }),
  },
  sandboxProxySupabase: {
    auth: { getUser: async () => ({ data: { user: null }, error: 'mocked' }) },
  },
  sandboxProxyFetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  sandboxProxySleep: async () => undefined,
  runSandboxProxyInterval: () => undefined,
}));

mock.module('../shared/preview-ownership', () => ({
  canAccessSandboxSession: async ({ userId }: { userId?: string }) =>
    Boolean(userId && mockDbSandbox && mockDbMembership),
  canAccessPreviewSandbox: async ({ userId }: { userId?: string }) =>
    Boolean(userId && mockDbSandbox && mockDbMembership),
  resolvePreviewUserContext: async (sandboxId: string, userId?: string) =>
    userId && mockDbSandbox && mockDbMembership
      ? { userId, sandboxId: mockSandboxRows()[0]?.sandboxId ?? sandboxId, sandboxRole: 'member', scopes: ['*'] }
      : null,
}));

// Daytona SDK mock
mock.module('../shared/daytona', () => ({
  getDaytona: () => ({
    get: async (sandboxId: string) => {
      return {
        getPreviewLink: async (port: number) => {
          return { url: mockPreviewUrl, token: mockPreviewToken };
        },
        start: async () => {
          mockWakeCalls.push(sandboxId);
        },
      };
    },
  }),
}));

mock.module('../platform/providers', () => ({
  WarmRuntimeUnavailableError: class WarmRuntimeUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WarmRuntimeUnavailableError';
    }
  },
  getProvider: () => ({
    resolvePreviewLink: async (_externalId: string, port: number) => {
      mockResolvedPreviewPorts.push(port);
      return { url: mockPreviewUrl, token: mockPreviewToken };
    },
    ensureRunning: async (sandboxId: string) => {
      mockWakeCalls.push(sandboxId);
    },
  }),
}));

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test-version',
  config: {
    isDaytonaEnabled: () => true,
    isJustAVPSEnabled: () => false,
  },
}));

mock.module('../projects/secrets', () => {
  const snapshot = (projectId: string) => ({
    env: {
      OPENROUTER_API_KEY: 'sk-live',
      SENTRY_DSN: 'https://example.test/1',
    },
    names: ['OPENROUTER_API_KEY', 'SENTRY_DSN'],
    revision: `rev-${projectId}`,
  });
  return {
    listProjectSecrets: async (projectId: string) => snapshot(projectId).env,
    listProjectSecretsForUser: async (projectId: string) => snapshot(projectId).env,
    listProjectSecretsSnapshot: async (projectId: string) => snapshot(projectId),
    listProjectSecretsSnapshotForUser: async (projectId: string) => snapshot(projectId),
    projectSecretsRevision: (env: Record<string, string>) => `rev-${Object.keys(env).sort().join('-')}`,
    getProjectSecretValue: async () => null,
  };
});

mock.module('../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async ({
    previewUrl,
    previewToken,
    serviceKey,
  }: {
    previewUrl: string;
    previewToken: string | null;
    serviceKey: string | null;
  }) => {
    if (!serviceKey) return;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    };
    if (previewToken) headers['X-Daytona-Preview-Token'] = previewToken;
    const res = await globalThis.fetch(`${previewUrl.replace(/\/$/, '')}/kortix/env`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        env: {
          OPENROUTER_API_KEY: 'sk-live',
          SENTRY_DSN: 'https://example.test/1',
        },
        llmGatewayDenyEnv: '',
        llmGatewayEnabled: false,
        names: ['OPENROUTER_API_KEY', 'SENTRY_DSN'],
        refreshModels: true,
        revision: 'rev-OPENROUTER_API_KEY-SENTRY_DSN',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`env sync failed: ${res.status}${body ? ` ${body}` : ''}`);
    }
  },
}));

mock.module('../iam', () => ({
  filterAccessibleProjectResources: async (
    _userId: string,
    _accountId: string,
    _projectId: string,
    _resourceType: string,
    resourceIds: string[],
  ) => resourceIds,
}));

// Override global fetch for proxy requests
const originalFetch = globalThis.fetch;
function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

  // Let non-proxy URLs through (e.g. internal Hono test requests)
  if (
    !urlStr.startsWith('https://preview.') &&
    !urlStr.startsWith('http://preview.')
  ) {
    return originalFetch(url, init);
  }

  const responseConfig = mockFetchResponses[mockFetchCallCount] || mockFetchResponses[mockFetchResponses.length - 1];
  mockFetchCallCount++;

  mockFetchCalls.push({
    url: urlStr,
    method: (init?.method || 'GET').toUpperCase(),
    headers: Object.fromEntries(new Headers(init?.headers as any).entries()),
    body: typeof init?.body === 'string'
      ? init.body
      : init?.body instanceof ArrayBuffer
        ? new TextDecoder().decode(init.body)
        : null,
  });

  if (!responseConfig) {
    return Promise.resolve(new Response('OK', { status: 200 }));
  }

  if (responseConfig.error) {
    return Promise.reject(responseConfig.error);
  }

  return Promise.resolve(
    new Response(responseConfig.body, {
      status: responseConfig.status,
      headers: responseConfig.headers || {},
    })
  );
}

// ─── Import proxy app AFTER mocks ────────────────────────────────────────────

const { sandboxProxyApp } = await import('../sandbox-proxy/index');
const { verifyKortixUserContext, KORTIX_USER_CONTEXT_HEADER } = await import('../shared/kortix-user-context');
const { resolvePreviewWsUpstream } = await import('../sandbox-proxy/routes/preview');

// ─── Test app factory ────────────────────────────────────────────────────────

function createProxyTestApp() {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await runWithContext(c.req.method, c.req.path, async () => {
      await next();
    }, c.req.header('traceparent'));
  });

  app.route('/v1/p', sandboxProxyApp);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const response: Record<string, unknown> = {
        error: true,
        message: err.message,
        status: err.status,
      };
      if (err.status === 503) {
        c.header('Retry-After', '10');
      }
      return c.json(response, err.status);
    }
    return c.json({ error: true, message: 'Internal server error', status: 500 }, 500);
  });

  app.notFound((c) => c.json({ error: true, message: 'Not found', status: 404 }, 404));

  return app;
}

// ─── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockDbSandbox = {
    sandboxId: TEST_SESSION_SANDBOX_ID,
    sessionId: '22222222-2222-4222-8222-222222222222',
    projectId: TEST_PROJECT_ID,
    accountId: 'account-001',
    status: 'active',
    config: { serviceKey: TEST_SERVICE_KEY },
    provider: 'daytona',
    baseUrl: null,
  };
  mockDbMembership = { accountRole: 'member' };
  mockPreviewUrl = 'https://preview.daytona.io/proxy-url';
  mockPreviewToken = 'daytona-preview-token-123';
  mockWakeCalls = [];
  mockFetchResponses = [{ status: 200, body: 'Hello from upstream' }];
  mockFetchCallCount = 0;
  mockFetchCalls = [];
  mockDbUpdateCalls = [];
  mockResolvedPreviewPorts = [];

  // Install mock fetch
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Preview proxy: websocket upstream resolution', () => {
  test('keeps Daytona PTY websocket upstreams on direct OpenCode port 4096', async () => {
    const upstream = await resolvePreviewWsUpstream({
      sandboxId: TEST_SANDBOX_ID,
      upstreamPort: 4096,
      userId: TEST_USER_ID,
      remainingPath: '/pty/pty_test/connect',
      queryString: '',
    });

    expect(upstream.ok).toBe(true);
    expect(mockResolvedPreviewPorts).toEqual([4096]);
    if (upstream.ok) {
      expect(upstream.url).toBe('wss://preview.daytona.io/proxy-url/pty/pty_test/connect');
    }
  });

  test('routes Platinum PTY websocket upstreams through the signed agent bridge on 8000', async () => {
    mockDbSandbox = { ...mockDbSandbox, provider: 'platinum' };
    mockPreviewUrl = 'https://8000-platinum.sbx.example';
    mockPreviewToken = null;

    const upstream = await resolvePreviewWsUpstream({
      sandboxId: TEST_SANDBOX_ID,
      upstreamPort: 4096,
      userId: TEST_USER_ID,
      remainingPath: '/pty/pty_test/connect',
      queryString: '',
    });

    expect(upstream.ok).toBe(true);
    expect(mockResolvedPreviewPorts).toEqual([8000]);
    if (upstream.ok) {
      const url = new URL(upstream.url);
      expect(`${url.origin}${url.pathname}`).toBe('wss://8000-platinum.sbx.example/pty/pty_test/connect');
      const queryContext = url.searchParams.get('__kortix_user_context');
      expect(queryContext).toBeTruthy();
      expect(verifyKortixUserContext(queryContext!, TEST_SERVICE_KEY).ok).toBe(true);
      expect(upstream.headers[KORTIX_USER_CONTEXT_HEADER]).toBe(queryContext!);
    }
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Preview proxy: auth', () => {
  test('returns 401 without auth token', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`);
    expect(res.status).toBe(401);
  });

  test('accepts Bearer token in Authorization header', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
  });

  test('accepts auth via session cookie', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Cookie: '__preview_session=valid-token' },
    });
    expect(res.status).toBe(200);
  });
});

describe('Preview proxy: port validation', () => {
  test('rejects non-numeric port', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/abc/path`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Invalid port');
  });

  test('rejects port 0', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/0/path`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(400);
  });

  test('rejects port > 65535', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/65536/path`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(400);
  });

  test('accepts port 1', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/1/path`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
  });

  test('accepts port 65535', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/65535/path`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
  });
});

describe('Preview proxy: ownership', () => {
  test('returns 404 when sandbox not found', async () => {
    mockDbSandbox = null;
    const app = createProxyTestApp();
    // Use unique sandbox ID to avoid cache hits from other tests
    const res = await app.request(`/v1/p/sandbox-not-found-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'sandbox not found' });
  });

  test('returns 403 when user has no membership', async () => {
    mockDbMembership = null;
    const app = createProxyTestApp();
    // Use unique sandbox ID to avoid cache hits
    const res = await app.request(`/v1/p/sandbox-no-member-002/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(403);
  });

  test.each(['provisioning', 'stopped', 'error'])(
    'returns 503 when sandbox status is %s',
    async (status) => {
      mockDbSandbox = { ...mockDbSandbox, status };
      const app = createProxyTestApp();
      const res = await app.request(`/v1/p/sandbox-not-ready-${status}/${TEST_PORT}/`, {
        headers: { Authorization: 'Bearer test' },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: `sandbox not ready (status: ${status})`,
        port: TEST_PORT,
        status: 503,
      });
    },
  );

  test('allows access when user is member', async () => {
    const app = createProxyTestApp();
    // Use unique sandbox ID
    const res = await app.request(`/v1/p/sandbox-member-003/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
  });

  test('prefers the active claimed row when an external id has older failed rows', async () => {
    mockDbSandbox = [
      {
        ...mockDbSandbox,
        sandboxId: '22222222-2222-4222-8222-222222222222',
        sessionId: '22222222-2222-4222-8222-222222222222',
        status: 'error',
        updatedAt: '2026-06-04T08:56:42.000Z',
      },
      {
        ...mockDbSandbox,
        sandboxId: TEST_SESSION_SANDBOX_ID,
        sessionId: TEST_SESSION_SANDBOX_ID,
        status: 'active',
        updatedAt: '2026-06-04T08:58:08.000Z',
      },
    ];

    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/shared-sandbox-ext/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello from upstream');
  });
});

describe('Preview proxy: forwarding', () => {
  test('proxies GET request and returns upstream response', async () => {
    mockFetchResponses = [{ status: 200, body: '<html>Hello</html>', headers: { 'content-type': 'text/html' } }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/page`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('<html>Hello</html>');
  });

  test('proxies POST request with body', async () => {
    mockFetchResponses = [{ status: 201, body: '{"id":"created"}' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/api/data`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(201);
    expect(mockFetchCalls).toHaveLength(1);
  });

  test('syncs latest project secrets before forwarding prompt_async', async () => {
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async?directory=%2Fworkspace`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockFetchCalls).toHaveLength(2);
    expect(mockFetchCalls[0].url).toBe('https://preview.daytona.io/proxy-url/kortix/env');
    expect(mockFetchCalls[0].method).toBe('POST');
    expect(mockFetchCalls[0].headers['authorization']).toBe(`Bearer ${TEST_SERVICE_KEY}`);
    expect(mockFetchCalls[0].headers['content-type']).toBe('application/json');
    expect(mockFetchCalls[0].headers['x-daytona-preview-token']).toBe('daytona-preview-token-123');
    expect(JSON.parse(mockFetchCalls[0].body ?? '{}')).toEqual({
      env: {
        OPENROUTER_API_KEY: 'sk-live',
        SENTRY_DSN: 'https://example.test/1',
      },
      llmGatewayDenyEnv: '',
      llmGatewayEnabled: false,
      names: ['OPENROUTER_API_KEY', 'SENTRY_DSN'],
      refreshModels: true,
      revision: 'rev-OPENROUTER_API_KEY-SENTRY_DSN',
    });
    expect(mockFetchCalls[1].url).toBe(
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async?directory=%2Fworkspace',
    );
  });

  test('allows prompt_async when requested agent matches the session-bound token agent', async () => {
    mockDbSandbox = { ...mockDbSandbox, agentName: 'reviewer' };
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent: 'reviewer', parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockFetchCalls.map((call) => call.url)).toEqual([
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async',
    ]);
  });

  test('strips legacy default agent before forwarding prompt_async to OpenCode', async () => {
    mockDbSandbox = { ...mockDbSandbox, agentName: 'default' };
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent: 'default', parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(JSON.parse(mockFetchCalls[1].body ?? '{}')).toEqual({
      parts: [{ type: 'text', text: 'hi' }],
    });
  });

  // Agent-lock enforcement is OFF by default (KORTIX_ENFORCE_SESSION_AGENT_LOCK
  // unset) — in-session agent switching is allowed. A prompt may run a different
  // concrete agent than the session booted with, and it's forwarded untouched.
  test('allows in-session agent switching by default (no 409, concrete agent forwarded)', async () => {
    mockDbSandbox = { ...mockDbSandbox, agentName: 'reviewer' };
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent: 'researcher', parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(JSON.parse(mockFetchCalls[1].body ?? '{}')).toEqual({
      agent: 'researcher',
      parts: [{ type: 'text', text: 'hi' }],
    });
  });

  // Regression: the reported "agent switch requires a new session" false positive.
  // A brand-new session is stored with the sentinel agent 'default'; the client
  // resolves "the default" to a concrete name and echoes it back. With enforcement
  // off this never 409s, and a concrete agent is forwarded untouched so the user
  // can switch agents within the session.
  test('allows a default session to run a concrete agent (forwarded untouched)', async () => {
    mockDbSandbox = { ...mockDbSandbox, agentName: 'default' };
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent: 'kortix', parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    // Concrete agent forwarded untouched (only the literal 'default' sentinel is stripped).
    expect(JSON.parse(mockFetchCalls[1].body ?? '{}')).toEqual({
      agent: 'kortix',
      parts: [{ type: 'text', text: 'hi' }],
    });
  });

  test('returns a clean proxy error when project env sync is rejected', async () => {
    mockFetchResponses = [{ status: 401, body: '{"error":"unauthorized"}' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('env sync failed: 401');
    expect(mockFetchCalls).toHaveLength(1);
    expect(mockFetchCalls[0].url).toBe('https://preview.daytona.io/proxy-url/kortix/env');
  });

  test('does not retry non-transient project env sync HTTP errors that mention network failures', async () => {
    mockFetchResponses = [{ status: 500, body: '{"error":"connection refused to metadata store"}' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('env sync failed: 500');
    expect(mockWakeCalls).toEqual([]);
    expect(mockFetchCalls).toHaveLength(1);
    expect(mockFetchCalls[0].url).toBe('https://preview.daytona.io/proxy-url/kortix/env');
  });

  test('retries transient project env sync failures before forwarding prompt_async', async () => {
    mockFetchResponses = [
      { status: 502, body: 'Bad Gateway' },
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockWakeCalls).toEqual([TEST_SANDBOX_ID]);
    expect(mockFetchCalls.map((call) => call.url)).toEqual([
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async',
    ]);
  });

  test('retries fetch-level project env sync connection failures before forwarding prompt_async', async () => {
    mockFetchResponses = [
      {
        status: 0,
        body: '',
        error: new Error('Unable to connect. Is the computer able to access the url?'),
      },
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockWakeCalls).toEqual([TEST_SANDBOX_ID]);
    expect(mockFetchCalls.map((call) => call.url)).toEqual([
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async',
    ]);
  });

  test('strips hop, auth, trace, and forces identity compression for forwarded request', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: {
        Authorization: 'Bearer test',
        Host: 'myapp.com',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        'X-Request-Id': 'caller-controlled',
        'Accept-Encoding': 'gzip, br',
        'X-Custom': 'keep-me',
      },
    });
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].headers['host']).toBeUndefined();
    expect(mockFetchCalls[0].headers['authorization']).toBe(`Bearer ${TEST_SERVICE_KEY}`);
    expect(mockFetchCalls[0].headers['accept-encoding']).toBe('identity');
    expect(mockFetchCalls[0].headers['x-custom']).toBe('keep-me');
    expect(mockFetchCalls[0].headers['traceparent']).toMatch(/^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/);
    expect(mockFetchCalls[0].headers['traceparent']).not.toBe('00-11111111111111111111111111111111-2222222222222222-01');
    expect(mockFetchCalls[0].headers['x-request-id']).not.toBe('caller-controlled');
  });

  test('injects Daytona headers', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(mockFetchCalls[0].headers['x-daytona-skip-preview-warning']).toBe('true');
    expect(mockFetchCalls[0].headers['x-daytona-disable-cors']).toBe('true');
    expect(mockFetchCalls[0].headers['x-daytona-preview-token']).toBe('daytona-preview-token-123');
  });

  test('forwards signed user context for session sandbox access', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/kortix/health`, {
      headers: { Authorization: 'Bearer test' },
    });

    const signedContext = mockFetchCalls[0].headers[KORTIX_USER_CONTEXT_HEADER.toLowerCase()];
    expect(signedContext).toBeTruthy();
    const verified = verifyKortixUserContext(signedContext, TEST_SERVICE_KEY);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.context).toMatchObject({
        userId: TEST_USER_ID,
        sandboxId: TEST_SESSION_SANDBOX_ID,
        sandboxRole: 'member',
        scopes: ['*'],
      });
    }
  });

  test('marks proxied session sandbox and owning session as active usage', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const sandboxId = 'touch-sandbox-001';
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${sandboxId}/${TEST_PORT}/kortix/health`, {
      headers: { Authorization: 'Bearer test' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(mockDbUpdateCalls.some((call) =>
      call.table === sessionSandboxes && call.updates.lastUsedAt instanceof Date,
    )).toBe(true);
    expect(mockDbUpdateCalls.some((call) =>
      call.table === projectSessions && call.updates.status === 'running',
    )).toBe(true);
  });

  test('surfaces daemon signed-context rejection as 502', async () => {
    mockFetchResponses = [{ status: 401, body: 'bad signature' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/kortix/health`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: 'sandbox proxy authentication rejected' });
  });

  test('forwards normalized trace headers to sandbox preview', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: {
        Authorization: 'Bearer test',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        'X-Request-Id': 'caller-controlled',
      },
    });
    const traceparent = mockFetchCalls[0].headers['traceparent'];
    expect(traceparent).toMatch(/^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/);
    expect(traceparent).not.toBe('00-11111111111111111111111111111111-2222222222222222-01');
    expect(mockFetchCalls[0].headers['x-request-id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(mockFetchCalls[0].headers['x-request-id']).not.toBe('caller-controlled');
  });

  test('creates trace headers when caller does not provide traceparent', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(mockFetchCalls[0].headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(mockFetchCalls[0].headers['x-request-id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  test('does NOT inject preview token when null', async () => {
    mockPreviewToken = null;
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    // Use unique sandbox ID + port to avoid preview link cache hits
    await app.request(`/v1/p/sandbox-no-token-010/9999/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(mockFetchCalls[0].headers['x-daytona-preview-token']).toBeUndefined();
  });

  test('strips token query param from upstream URL', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/page?token=secret&other=keep`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(mockFetchCalls[0].url).toContain('other=keep');
    expect(mockFetchCalls[0].url).not.toContain('token=secret');
  });

  test('preserves remaining path after sandbox/port prefix', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/api/v2/data`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(mockFetchCalls[0].url).toContain('/api/v2/data');
  });
});

describe('Preview proxy: CORS', () => {
  test('sets CORS headers when Origin is present', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test', Origin: 'https://app.kortix.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.kortix.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('does NOT set CORS headers when no Origin', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    // CORS headers should not be present (or be null)
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Preview proxy: auto-wake ("no IP address found")', () => {
  test('triggers wake and retries when upstream returns sandbox-down 400', async () => {
    // First response: sandbox down, second: success
    mockFetchResponses = [
      { status: 400, body: 'no IP address found for sandbox' },
      { status: 200, body: 'Sandbox is back!' },
    ];
    const app = createProxyTestApp();

    // Override setTimeout to be instant for test speed
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('Sandbox is back!');
    expect(mockWakeCalls.length).toBe(1);
    expect(mockWakeCalls[0]).toBe(TEST_SANDBOX_ID);
  });
});

describe('Preview proxy: auto-wake ("failed to get runner info")', () => {
  test('triggers wake for archived sandbox', async () => {
    mockFetchResponses = [
      { status: 400, body: 'failed to get runner info: 404 Not Found' },
      { status: 200, body: 'Sandbox restored!' },
    ];
    const app = createProxyTestApp();

    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('Sandbox restored!');
    expect(mockWakeCalls.length).toBe(1);
  });
});

describe('Preview proxy: non-sandbox-down 400', () => {
  test('passes through 400 that is NOT sandbox-down', async () => {
    mockFetchResponses = [
      { status: 400, body: 'Bad request: invalid input' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/api`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ bad: 'data' }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe('Bad request: invalid input');
  });
});

describe('Preview proxy: retry exhaustion', () => {
  test('returns 502 when all retries fail with connection errors', async () => {
    // Simulate connection errors (fetch throws) for all attempts
    // To do this, make all fetch calls throw
    const savedFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = ((url: any) => {
      callCount++;
      return Promise.reject(new Error('Connection refused'));
    }) as any;

    const app = createProxyTestApp();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    const res = await app.request(`/v1/p/sandbox-retry-exhaust-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({
      error: 'sandbox upstream unreachable',
      port: TEST_PORT,
      status: 502,
    });
    // Should have made 4 attempts (0, 1, 2, 3)
    expect(callCount).toBe(4);
  });

  test('returns last 400 when all retries get sandbox-down (HTTP 400 path)', async () => {
    // On the last attempt (attempt 3), the code does NOT retry the 400 —
    // it passes it through because attempt < MAX_RETRIES is false.
    // So with 4 sandbox-down 400s, we get 400 on the 4th attempt.
    mockFetchResponses = [
      { status: 400, body: 'no IP address found' },
      { status: 400, body: 'no IP address found' },
      { status: 400, body: 'no IP address found' },
      { status: 400, body: 'no IP address found' },
    ];
    const app = createProxyTestApp();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    const res = await app.request(`/v1/p/sandbox-retry-400-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;

    // On the 4th attempt, attempt=3, condition is attempt < MAX_RETRIES (3 < 3 = false)
    // So the 400 passes through to the "Got an HTTP response" section
    expect(res.status).toBe(400);
  });

  test('wake is triggered only once across retries', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('Connection refused'))) as any;

    const app = createProxyTestApp();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    await app.request(`/v1/p/sandbox-retry-wake-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    // Wake should be called only once (not once per retry)
    expect(mockWakeCalls.length).toBe(1);
  });
});

describe('Preview proxy: no-trailing-slash', () => {
  test('handles /:sandboxId/:port without trailing slash (proxies or redirects)', async () => {
    const app = createProxyTestApp();
    // In Hono v4, the /:sandboxId/:port/* route may match even without trailing slash.
    // The request either gets proxied (200) or redirected (301) — both are valid.
    const res = await app.request(`/v1/p/sandbox-redirect-001/${TEST_PORT}`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect([200, 301]).toContain(res.status);
  });
});
