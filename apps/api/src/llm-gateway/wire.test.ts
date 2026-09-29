import { afterEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Hono } from 'hono';

// The mount answers with a raw `Response` (the gateway proxy), so this test
// exercises the real Hono wiring. Mocked: config (proxy target + limit), the
// DB-backed control-plane routes, and the audit write the deny path records.
mock.module('../config', () => ({
  config: {
    LLM_GATEWAY_ENABLED: true,
    LLM_GATEWAY_PROXY_TARGET: 'http://gateway.test',
    LLM_GATEWAY_PROXY_PORT: 0,
    KORTIX_LLM_GATEWAY_REQS_PER_MIN: 2,
  },
}));
mock.module('./internal-routes', () => ({
  createInternalGatewayRoutes: () => new Hono(),
}));
mock.module('../shared/audit', () => ({
  recordAuditEvent: async () => undefined,
}));

const { mountLlmGateway } = await import('./wire');
const { resetRateLimiters } = await import('../shared/rate-limit');

let fetched = 0;
function stubUpstream(body = '{"models":{}}') {
  fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function mountedApp() {
  const app = new OpenAPIHono();
  mountLlmGateway(app as never);
  return app;
}

describe('LLM gateway mount — per-credential rate limit', () => {
  afterEach(() => resetRateLimiters());

  test('in-limit traffic reaches the proxy and carries the X-RateLimit-* headers', async () => {
    stubUpstream();
    const res = await mountedApp().request('/v1/llm/v1/models?scope=managed', {
      headers: { authorization: 'Bearer kgw_unit_test_alpha' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('1');
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    expect(fetched).toBe(1);
  });

  test('a burst above the limit is 429 + Retry-After and never reaches the proxy', async () => {
    stubUpstream();
    const app = mountedApp();
    const headers = { authorization: 'Bearer kgw_unit_test_burst' };

    expect((await app.request('/v1/llm-gateway/v1/models', { headers })).status).toBe(200);
    expect((await app.request('/v1/llm-gateway/v1/models', { headers })).status).toBe(200);

    const third = await app.request('/v1/llm-gateway/v1/models', { headers });
    expect(third.status).toBe(429);
    expect(third.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(third.headers.get('Retry-After')).toBeTruthy();
    expect(await third.json()).toMatchObject({ error: 'rate_limit_exceeded' });
    expect(fetched).toBe(2);
  });

  test('each credential has its own bucket', async () => {
    stubUpstream();
    const app = mountedApp();

    expect(
      (
        await app.request('/v1/llm/v1/models', {
          headers: { authorization: 'Bearer kgw_unit_test_one' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/v1/llm/v1/models', {
          headers: { authorization: 'Bearer kgw_unit_test_one' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/v1/llm/v1/models', {
          headers: { authorization: 'Bearer kgw_unit_test_one' },
        })
      ).status,
    ).toBe(429);

    // A different credential still has its full budget.
    expect(
      (
        await app.request('/v1/llm/v1/models', {
          headers: { authorization: 'Bearer kgw_unit_test_two' },
        })
      ).status,
    ).toBe(200);
  });

  test('a request without a bearer is bounded by client address, not exempt', async () => {
    stubUpstream();
    const app = mountedApp();
    const headers = { 'x-real-ip': '203.0.113.77' };

    expect((await app.request('/v1/llm/v1/models', { headers })).status).toBe(200);
    expect((await app.request('/v1/llm/v1/models', { headers })).status).toBe(200);
    expect((await app.request('/v1/llm/v1/models', { headers })).status).toBe(429);
  });
});
