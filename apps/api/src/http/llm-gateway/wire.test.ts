// The /v1/llm and /v1/llm-gateway/* reverse proxy must not classify a CLIENT
// disconnect as a gateway 5xx. The sandbox boot fetch gives the model catalog a
// 2 s budget (`MANAGED_MODELS_TIMEOUT_MS`) and aborts the rest; before this
// guard the abort surfaced as `gateway_proxy_error: The connection was closed.`
// with HTTP 503, so a routine client cancel was logged and counted as a 5xx on
// `GET /v1/llm-gateway/v1/models` and paged the infra sweep.
import { afterAll, describe, expect, test } from 'bun:test';

// config reads its source env at import; set the minimum it validates before.
process.env.KORTIX_URL = 'https://api.example.com';
process.env.FRONTEND_URL = 'https://app.example.com';

const { config } = await import('../../lib/config');
const { makeOpenApiApp } = await import('../openapi');
const { mountLlmGateway } = await import('./wire');

// Fake standalone gateway: distinct paths for each behavior under test.
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/v1/slow') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return new Response(JSON.stringify({ models: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path === '/v1/html5xx') {
      return new Response('<html><title>502 Bad Gateway</title></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(JSON.stringify({ models: { 'test-model': { name: 'Test' } } }), {
      headers: { 'content-type': 'application/json' },
    });
  },
});

// `proxyBase` is captured at mount time — configure the target first.
const previousEnabled = config.LLM_GATEWAY_ENABLED;
const previousTarget = config.LLM_GATEWAY_PROXY_TARGET;
config.LLM_GATEWAY_ENABLED = true;
config.LLM_GATEWAY_PROXY_TARGET = `http://127.0.0.1:${upstream.port}`;

const app = makeOpenApiApp();
mountLlmGateway(app);

afterAll(() => {
  upstream.stop(true);
  config.LLM_GATEWAY_ENABLED = previousEnabled;
  config.LLM_GATEWAY_PROXY_TARGET = previousTarget;
});

describe('llm gateway reverse proxy', () => {
  test('relays a 200 from the gateway unchanged', async () => {
    const res = await app.request('http://localhost/v1/llm-gateway/v1/models');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: { 'test-model': { name: 'Test' } } });
  });

  test('a client disconnect is 499, never a gateway 5xx', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    const res = await app.request('http://localhost/v1/llm-gateway/v1/slow', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 499, not 5xx: the client cancel must not move the route's 5xx metric.
    expect(res.status).toBe(499);
  });

  test('a non-JSON upstream 5xx still becomes the typed 503 envelope', async () => {
    const res = await app.request('http://localhost/v1/llm-gateway/v1/html5xx');
    expect(res.status).toBe(503);
    expect((await res.json()) as { code?: string }).toMatchObject({
      code: 'gateway_proxy_error',
    });
  });
});
