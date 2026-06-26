import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/auth-token', () => ({
  getSupabaseAccessTokenWithRetry: async () => 'test-access-token',
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
