import { afterEach, expect, mock, test } from 'bun:test';

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.FRONTEND_URL = 'http://127.0.0.1:3000';
const { config } = await import('../config');
config.LLM_GATEWAY_ENABLED = true;
config.LLM_GATEWAY_PROXY_TARGET = 'http://gateway.test';
const actualHooks = await import('./hooks');
mock.module('./hooks', () => ({
  ...actualHooks,
  authenticatePrincipal: async (token: string) =>
    token === 'invalid'
      ? null
      : { accountId: token === 'other' ? 'other' : 'first', userId: 'synthetic-user' },
}));
mock.module('../shared/audit', () => ({ recordAuditEvent: async () => {} }));

const { mountLlmGateway } = await import('./wire');
const { resetRateLimiters } = await import('../shared/rate-limit');
const { makeOpenApiApp } = await import('../openapi');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRateLimiters();
});

test('both gateway prefixes share an account bucket; upstream responses retain headers', async () => {
  const upstream = mock(
    async () => new Response('{"models":{}}', { headers: { 'content-type': 'application/json' } }),
  );
  globalThis.fetch = upstream as unknown as typeof fetch;
  const app = makeOpenApiApp();
  mountLlmGateway(app);
  const request = (path: string, token: string) =>
    app.request(path, { headers: { authorization: `Bearer ${token}` } });

  const first = await request('/v1/llm-gateway/v1/models?scope=managed', 'first');
  expect(first.status).toBe(200);
  expect(first.headers.get('x-ratelimit-limit')).toBe('600');
  expect(first.headers.get('x-ratelimit-remaining')).toBe('599');
  const alias = await request('/v1/llm/v1/models', 'first');
  expect(alias.headers.get('x-ratelimit-remaining')).toBe('598');
  expect((await request('/v1/llm/models', 'other')).headers.get('x-ratelimit-remaining')).toBe(
    '599',
  );
  expect((await request('/v1/llm/models', 'invalid')).status).toBe(401);

  for (let i = 2; i < 600; i++) await request('/v1/llm/models', 'first');
  const denied = await request('/v1/llm-gateway/v1/models', 'first');
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(denied.headers.get('x-ratelimit-remaining')).toBe('0');
  expect(upstream).toHaveBeenCalledTimes(601);
});
