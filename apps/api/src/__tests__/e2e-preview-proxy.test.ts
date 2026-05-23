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
const TEST_SERVICE_KEY = 'test-service-key-123';
const TEST_PORT = 8080;

let mockDbSandbox: any = {
  sandboxId: TEST_SESSION_SANDBOX_ID,
  accountId: 'account-001',
  status: 'active',
  config: { serviceKey: TEST_SERVICE_KEY },
  provider: 'daytona',
  baseUrl: null,
};
let mockDbMembership: any = { accountRole: 'member' };
let mockPreviewUrl = 'https://preview.daytona.io/proxy-url';
let mockPreviewToken: string | null = 'daytona-preview-token-123';
let mockDaytonaGetError: Error | null = null;
let mockPreviewLinkError: Error | null = null;
let mockWakeCalls: string[] = [];
let mockFetchResponses: Array<{ status: number; body: string; headers?: Record<string, string> }> = [];
let mockFetchCallCount = 0;
let mockFetchCalls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
let mockDbUpdateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];

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
          ['accountId', 'sandboxId', 'status', 'config', 'provider', 'baseUrl'].includes(key),
        );
        const isMembershipQuery = fieldKeys.includes('accountRole');

        return {
          from: (table: any) => ({
            where: (condition: any) => ({
              limit: (n: number) => {
                if (isSandboxQuery) {
                  return Promise.resolve(mockDbSandbox ? [mockDbSandbox] : []);
                }
                if (isMembershipQuery) {
                  return Promise.resolve(mockDbMembership ? [mockDbMembership] : []);
                }
                // Fallback: return empty (unknown query)
                return Promise.resolve([]);
              },
            }),
          }),
        };
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

mock.module('../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async ({ userId }: { userId?: string }) =>
    Boolean(userId && mockDbSandbox && mockDbMembership),
  resolvePreviewUserContext: async (sandboxId: string, userId?: string) =>
    userId && mockDbSandbox && mockDbMembership
      ? { userId, sandboxId: mockDbSandbox.sandboxId ?? sandboxId, sandboxRole: 'member', scopes: ['*'] }
      : null,
  clearPreviewOwnershipCache: () => {},
}));

// Daytona SDK mock
mock.module('../shared/daytona', () => ({
  getDaytona: () => ({
    get: async (sandboxId: string) => {
      if (mockDaytonaGetError) throw mockDaytonaGetError;
      return {
        getPreviewLink: async (port: number) => {
          if (mockPreviewLinkError) throw mockPreviewLinkError;
          return { url: mockPreviewUrl, token: mockPreviewToken };
        },
        start: async () => {
          mockWakeCalls.push(sandboxId);
        },
      };
    },
  }),
}));

mock.module('../config', () => ({
  config: {
    isDaytonaEnabled: () => true,
    isLocalDockerEnabled: () => false,
    isJustAVPSEnabled: () => false,
  },
}));

// Override global fetch for proxy requests
const originalFetch = globalThis.fetch;
function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

  // Let non-proxy URLs through (e.g. internal Hono test requests)
  if (!urlStr.startsWith('https://preview.') && !urlStr.startsWith('http://preview.')) {
    return originalFetch(url, init);
  }

  const responseConfig = mockFetchResponses[mockFetchCallCount] || mockFetchResponses[mockFetchResponses.length - 1];
  mockFetchCallCount++;

  mockFetchCalls.push({
    url: urlStr,
    method: (init?.method || 'GET').toUpperCase(),
    headers: Object.fromEntries(new Headers(init?.headers as any).entries()),
  });

  if (!responseConfig) {
    return Promise.resolve(new Response('OK', { status: 200 }));
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
    accountId: 'account-001',
    status: 'active',
    config: { serviceKey: TEST_SERVICE_KEY },
    provider: 'daytona',
    baseUrl: null,
  };
  mockDbMembership = { accountRole: 'member' };
  mockPreviewUrl = 'https://preview.daytona.io/proxy-url';
  mockPreviewToken = 'daytona-preview-token-123';
  mockDaytonaGetError = null;
  mockPreviewLinkError = null;
  mockWakeCalls = [];
  mockFetchResponses = [{ status: 200, body: 'Hello from upstream' }];
  mockFetchCallCount = 0;
  mockFetchCalls = [];
  mockDbUpdateCalls = [];

  // Install mock fetch
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
      expect(body).toEqual({ error: 'sandbox not ready', status });
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
    expect(body.message).toContain('upstream unreachable');
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
