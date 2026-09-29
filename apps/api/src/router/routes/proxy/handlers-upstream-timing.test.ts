import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

import { getDiagnosticFields, runWithContext } from '../../../lib/request-context';
import { upstreamMsSoFar, upstreamTiming } from '../../../middleware/upstream-timing';

// KRTX-577: POST /v1/router/tavily/search p95 rose to ~21 s against a 3.8 s
// baseline, and no telemetry could say whether Tavily's upstream or this API's
// own work (auth + credit reservation) caused it — the completion log line
// carried only the total `duration` because the proxy never attributed its
// upstream fetch. These tests pin that attribution: a slow upstream must show
// up in `upstream_ms`, a slow reservation must NOT, and the completion log
// line must carry the split.

const DELAY_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fastUpstream = () =>
  new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const slowUpstream = async (): Promise<Response> => {
  await sleep(DELAY_MS);
  return fastUpstream();
};

const reserveDelays: number[] = [];

mock.module('../../../config', () => ({
  config: {
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    OPENROUTER_API_URL: 'https://openrouter.example',
  },
  KORTIX_MARKUP: 1.2,
}));

// handlers.ts imports the llm-reservation module, whose import chain reaches
// the billing service. Tavily is not an LLM service, so stub it the same way
// handlers-byok.test.ts does.
mock.module('../../services/llm-reservation', () => ({
  reserveEstimatedLlmCredits: async () => null,
  settleLlmReservation: async () => undefined,
  refundLlmReservation: async () => undefined,
}));

mock.module('./helpers', () => ({
  tryAuthenticate: async () => ({ isKortixUser: true, accountId: 'acct-synthetic' }),
  buildForwardHeaders: () => new Headers(),
  getRequestBody: async () => JSON.stringify({ query: 'synthetic search' }),
  maybeNormalizeOpenAIResponsesInput: (_s: unknown, _m: string, _p: string, body: unknown) => body,
  matchAllowedRoute: () => ({
    path: '/search',
    methods: ['POST'],
    billingToolName: 'proxy_tavily',
  }),
  reserveToolProxyCredits: async () => {
    const ms = reserveDelays.shift() ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    return null;
  },
  refundToolReservation: async () => undefined,
  injectApiKey: (_s: unknown, _h: Headers, body: unknown) => body,
}));

const { handleProxy } = await import('./handlers');

const originalFetch = globalThis.fetch;

const service = {
  name: 'tavily',
  targetBaseUrl: 'https://upstream.example',
  billingToolName: 'proxy_tavily',
  getKortixApiKey: () => 'kortix-managed-key',
  allowedRoutes: [{ path: '/search', methods: ['POST'] }],
};

const context = {
  req: {
    url: 'https://api.example/v1/router/tavily/search',
    method: 'POST',
    header: () => undefined,
  },
} as never;

interface Measured {
  status: number;
  totalMs: number;
  upstreamMs: number;
  loggedUpstreamMs: string | undefined;
}

async function measure(): Promise<Measured> {
  return runWithContext('POST', '/v1/router/tavily/search', async () => {
    const start = performance.now();
    const response = await handleProxy(context, service as never, 'tavily');
    const totalMs = performance.now() - start;
    return {
      status: response.status,
      totalMs,
      upstreamMs: upstreamMsSoFar(),
      loggedUpstreamMs: getDiagnosticFields().upstream_ms,
    };
  });
}

beforeEach(() => {
  reserveDelays.length = 0;
  globalThis.fetch = (async () => fastUpstream()) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('proxy upstream attribution (KRTX-577)', () => {
  test('a slow upstream fills upstream_ms and leaves the in-process remainder small', async () => {
    globalThis.fetch = slowUpstream as unknown as typeof fetch;
    const measured = await measure();

    expect(measured.status).toBe(200);
    // The Tavily fetch is the measured upstream wait.
    expect(measured.upstreamMs).toBeGreaterThanOrEqual(200);
    // Everything that is not the upstream call (auth, reservation, body) is
    // far below the upstream wait on this request.
    const inProcessMs = measured.totalMs - measured.upstreamMs;
    expect(inProcessMs).toBeLessThan(measured.upstreamMs);
    // The `Request completed` log line reads this exact field, so the split
    // is queryable in ClickHouse, not only in this process.
    expect(measured.loggedUpstreamMs).toBe(String(Math.round(measured.upstreamMs)));
  });

  test('a slow credit reservation does NOT inflate upstream_ms', async () => {
    reserveDelays.push(DELAY_MS);
    const measured = await measure();

    expect(measured.status).toBe(200);
    // The upstream call itself stayed fast.
    expect(measured.upstreamMs).toBeLessThan(200);
    // The reservation delay lands in the in-process remainder.
    const inProcessMs = measured.totalMs - measured.upstreamMs;
    expect(inProcessMs).toBeGreaterThanOrEqual(200);
    expect(measured.loggedUpstreamMs).toBe(String(Math.round(measured.upstreamMs)));
  });

  test('the proxied response carries the split in its Server-Timing header', async () => {
    // Drives the real middleware chain: upstreamTiming emits the header, the
    // handler records the upstream wait through it.
    globalThis.fetch = slowUpstream as unknown as typeof fetch;

    const app = new Hono();
    app.use('*', (c, next) => runWithContext('POST', c.req.path, () => next()));
    app.use('*', upstreamTiming);
    app.all('/v1/router/tavily/*', (c) => handleProxy(c, service as never, 'tavily'));

    const response = await app.request('https://api.example/v1/router/tavily/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'synthetic search' }),
    });

    expect(response.status).toBe(200);
    const timing = parseServerTiming(response.headers.get('server-timing'));
    expect(timing.up).toBeGreaterThanOrEqual(200);
    expect(timing.api).toBeGreaterThanOrEqual(0);
  });
});

function parseServerTiming(value: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of (value ?? '').split(',')) {
    const match = /^\s*([\w-]+)\s*;\s*dur=([\d.]+)\s*$/.exec(entry);
    const name = match?.[1];
    const duration = match?.[2];
    if (name && duration) out[name] = Number(duration);
  }
  return out;
}
