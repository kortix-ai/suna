/**
 * Unit test for local-preview proxy connection error handling.
 *
 * Verifies that when Bun's fetch() throws "Unable to connect" (ECONNREFUSED),
 * the proxy returns a proper 503 instead of propagating as an unhandled 500.
 *
 * Related: Betterstack incident #956953141
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// ─── Mock config ─────────────────────────────────────────────────────────────

mock.module('../config', () => ({
  config: {
    isDaytonaEnabled: () => false,
    isLocalDockerEnabled: () => true,
    isJustAVPSEnabled: () => false,
    SANDBOX_CONTAINER_NAME: 'kortix-sandbox',
    SANDBOX_PORT_BASE: 3001,
    SANDBOX_NETWORK: '',
    INTERNAL_SERVICE_KEY: 'test-service-key',
    DOCKER_HOST: '',
    KORTIX_URL: '',
    PORT: 8008,
  },
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            provider: 'local_docker',
            baseUrl: 'http://localhost:3001',
            config: { serviceKey: 'test-service-key' },
            metadata: {},
          }]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  },
}));

mock.module('@kortix/db', () => ({
  sandboxes: {
    sandboxId: 'sandboxId',
    externalId: 'externalId',
    provider: 'provider',
    baseUrl: 'baseUrl',
    config: 'config',
    metadata: 'metadata',
    status: 'status',
    accountId: 'accountId',
  },
}));

mock.module('../middleware/auth', () => ({
  combinedAuth: async (_c: any, next: any) => { await next(); },
  supabaseAuth: async (_c: any, next: any) => { await next(); },
  apiKeyAuth: async (_c: any, next: any) => { await next(); },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => 'account-001',
}));

mock.module('../platform/providers/justavps', () => ({
  isProxyTokenStale: () => false,
  refreshSandboxProxyToken: async () => null,
}));

mock.module('../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async () => true,
  resolvePreviewUserContext: async () => null,
}));

mock.module('../shared/kortix-user-context', () => ({
  encodeKortixUserContext: () => 'signed-token',
  KORTIX_USER_CONTEXT_HEADER: 'X-Kortix-User-Context',
}));

mock.module('../platform/services/sandbox-auth', () => ({
  buildCanonicalSandboxAuthCommand: () => 'echo auth',
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────────

const { proxyToSandbox } = await import('../sandbox-proxy/routes/local-preview');

// ─── Tests ───────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('proxyToSandbox: connection error handling', () => {
  test('returns 503 when Bun throws "Unable to connect" (ECONNREFUSED)', async () => {
    // Simulate Bun's ECONNREFUSED error message
    globalThis.fetch = (() =>
      Promise.reject(new Error('Unable to connect. Is the computer able to access the url?'))
    ) as any;

    const headers = new Headers({ host: 'localhost:8008' });
    const response = await proxyToSandbox(
      'kortix-sandbox',
      8000,
      'GET',
      '/kortix/health',
      '',
      headers,
      undefined,  // body
      false,      // acceptsSSE
      'http://localhost:3000',
    );

    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.error).toBe(true);
    expect(body.message).toContain('starting up');
    expect(body.status).toBe(503);
    // CORS should be set from origin
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
  });

  test('returns 503 when fetch throws ECONNREFUSED (Node-style)', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('fetch failed: ECONNREFUSED 127.0.0.1:3001'))
    ) as any;

    const headers = new Headers({ host: 'localhost:8008' });
    const response = await proxyToSandbox(
      'kortix-sandbox',
      8000,
      'GET',
      '/kortix/health',
      '',
      headers,
      undefined,
      false,
      'http://localhost:3000',
    );

    expect(response.status).toBe(503);
  });

  test('returns 503 when fetch throws ECONNRESET', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('fetch failed: ECONNRESET'))
    ) as any;

    const headers = new Headers({ host: 'localhost:8008' });
    const response = await proxyToSandbox(
      'kortix-sandbox',
      8000,
      'GET',
      '/kortix/health',
      '',
      headers,
      undefined,
      false,
      '',
    );

    expect(response.status).toBe(503);
  });

  test('re-throws non-connection errors (e.g. AbortError)', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
    ) as any;

    const headers = new Headers({ host: 'localhost:8008' });
    await expect(
      proxyToSandbox(
        'kortix-sandbox',
        8000,
        'GET',
        '/kortix/health',
        '',
        headers,
        undefined,
        false,
        '',
      )
    ).rejects.toThrow();
  });

  test('returns upstream response normally when fetch succeeds', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any;

    const headers = new Headers({ host: 'localhost:8008' });
    const response = await proxyToSandbox(
      'kortix-sandbox',
      8000,
      'GET',
      '/kortix/health',
      '',
      headers,
      undefined,
      false,
      '',
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe('{"status":"ok"}');
  });
});
