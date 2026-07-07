import { beforeEach, describe, expect, mock, test } from 'bun:test';
// Narrow subpath: loads only the SDK config module, not the full barrel (which
// would pull projects-client + reorder module load → a transient ESM cycle).
import { configureKortix } from '@kortix/sdk/config';

mock.module('@/lib/auth-token', () => ({
  getSupabaseAccessToken: async () => 'test-access-token',
  getSupabaseAccessTokenWithRetry: async () => 'test-access-token',
  getAuthToken: async () => 'test-access-token',
  getAuthTokenWithRetry: async () => 'test-access-token',
  invalidateTokenCache: () => {},
  setBootstrapAuthToken: () => {},
  setCachedAuthToken: () => {},
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ BACKEND_URL: '/v1' }),
}));

mock.module('./error-handler', () => ({
  handleApiError: () => {},
  handleNetworkError: () => {},
}));

describe('backendApi', () => {
  beforeEach(() => {
    mock.restore();
    // `@/lib/api-client` re-exports `@kortix/sdk/api-client`, which reads its token
    // + backendUrl from the SDK platform config (configureKortix), NOT the web's
    // `@/lib/auth-token`. Wire the SDK seam so the test exercises the real shimmed
    // path instead of short-circuiting on a null token.
    configureKortix({ backendUrl: '/v1', getToken: async () => 'test-access-token' });
  });

  test('uses bearer auth and omits browser cookies by default', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { backendApi } = await import('./api-client');
    const res = await backendApi.get('/billing/account-state');

    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].credentials).toBe('omit');
    expect((calls[0].headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
  });
});

describe('setAdminBypass / isAdminBypassEnabled', () => {
  beforeEach(() => {
    mock.restore();
  });

  test('toggles on and off', async () => {
    const { setAdminBypass, isAdminBypassEnabled } = await import('./api-client');
    expect(isAdminBypassEnabled()).toBe(false);
    setAdminBypass(true);
    expect(isAdminBypassEnabled()).toBe(true);
    setAdminBypass(false);
    expect(isAdminBypassEnabled()).toBe(false);
  });

  test('attaches x-kortix-admin-bypass to requests when enabled, omits it when disabled', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { backendApi, setAdminBypass } = await import('./api-client');

    setAdminBypass(true);
    await backendApi.get('/projects/abc/detail');
    expect((calls[0].headers as Record<string, string>)['x-kortix-admin-bypass']).toBe('1');

    setAdminBypass(false);
    await backendApi.get('/projects/abc/detail');
    expect((calls[1].headers as Record<string, string>)['x-kortix-admin-bypass']).toBeUndefined();
  });
});
