import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

import { getDiagnosticFields, runWithContext } from '../../../lib/request-context';
import { upstreamMsSoFar } from '../../../middleware/upstream-timing';

// KRTX-2073: POST /v1/router/firecrawl/v2/scrape returned 36×500 in 7 minutes
// (2026-10-09 22:43–22:50 UTC, upstream_ms ≈ duration, avg ≈46 s) and the logs
// held no reason at all — the proxy forwards the upstream status verbatim, so
// a provider-side failure never throws and never logs, and a 5xx spike can
// only be diagnosed from the absence of error lines. These tests pin both
// halves: the response still passes through unchanged, and an upstream 5xx
// now emits ONE bounded warn line that names the service, the route and the
// upstream's own reason, with target URLs masked (the url is caller data).

const warnLines: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
const refunds: string[] = [];

mock.module('../../../config', () => ({
  config: { KORTIX_BILLING_INTERNAL_ENABLED: true },
}));

mock.module('./helpers', () => ({
  tryAuthenticate: async () => ({ isKortixUser: true, accountId: 'acct-synthetic' }),
  buildForwardHeaders: () => new Headers(),
  getRequestBody: async () => JSON.stringify({ url: 'https://93.184.216.34/page' }),
  matchAllowedRoute: () => ({ path: '/v2/scrape', methods: ['POST'] }),
  reserveToolProxyCredits: async () => 'reservation-synthetic',
  refundToolReservation: async (_reservation: unknown, description: string) => {
    refunds.push(description);
  },
  injectApiKey: (_service: unknown, _headers: Headers, body: unknown) => body,
}));

mock.module('../../../lib/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: (message: string, context?: Record<string, unknown>) => {
      warnLines.push({ message, context });
    },
    error: () => {},
  },
}));

const { handleProxy } = await import('./handlers');

const originalFetch = globalThis.fetch;

const firecrawl = {
  name: 'firecrawl',
  targetBaseUrl: 'https://api.firecrawl.dev',
  getKortixApiKey: () => 'kortix-managed-key',
  keyInjection: { type: 'header' as const, headerName: 'Authorization', prefix: 'Bearer ' },
  allowedRoutes: [{ path: '/v2/scrape', methods: ['POST'] }],
  billingToolName: 'proxy_firecrawl',
};

const context = {
  req: {
    url: 'https://api.example/v1/router/firecrawl/v2/scrape',
    method: 'POST',
    header: () => undefined,
  },
} as never;

const upstreamError = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  warnLines.length = 0;
  refunds.length = 0;
  globalThis.fetch = (async () => upstreamError(200, '{"ok":true}')) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function call(): Promise<Response> {
  return runWithContext('POST', '/v1/router/firecrawl/v2/scrape', () =>
    handleProxy(context, firecrawl as never, 'firecrawl'),
  );
}

describe('proxy upstream error diagnostics (KRTX-2073)', () => {
  test('an upstream 500 passes through verbatim: same status, body and headers', async () => {
    globalThis.fetch = (async () =>
      upstreamError(500, '{"error":"Request timed out","code":"SCRAPE_TIMEOUT"}')) as unknown as typeof fetch;

    const response = await call();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"Request timed out","code":"SCRAPE_TIMEOUT"}');
    expect(response.headers.get('content-type')).toBe('application/json');
    // The failed scrape is still refunded, not billed.
    expect(refunds).toEqual(['Tool reservation refund after upstream error: firecrawl']);
  });

  test('an upstream 500 emits one warn line naming the service, route and upstream reason', async () => {
    globalThis.fetch = (async () =>
      upstreamError(500, '{"error":"Request timed out","code":"SCRAPE_TIMEOUT"}')) as unknown as typeof fetch;

    const response = await call();

    expect(response.status).toBe(500);
    expect(warnLines).toHaveLength(1);
    const { message, context: fields } = warnLines[0];
    expect(message).toContain('firecrawl');
    expect(message).toContain('500');
    expect(message).toContain('POST /v2/scrape');
    expect(message).toContain('Request timed out');
    expect(fields?.upstream_status).toBe(500);
  });

  test('the warn line masks target URLs from the upstream error body', async () => {
    globalThis.fetch = (async () =>
      upstreamError(
        500,
        '{"error":"failed to scrape https://secret-customer.example/internal after 45000ms"}',
      )) as unknown as typeof fetch;

    const response = await call();

    expect(response.status).toBe(500);
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0].message).not.toContain('secret-customer.example');
    expect(warnLines[0].message).toContain('<url>');
  });

  test('the warn line stays bounded on a large upstream error body', async () => {
    const hugeReason = 'x'.repeat(50_000);
    globalThis.fetch = (async () =>
      upstreamError(500, `{"error":"${hugeReason}"}`)) as unknown as typeof fetch;

    const response = await call();

    expect(response.status).toBe(500);
    // The client still gets the full upstream body.
    expect((await response.text()).length).toBeGreaterThan(50_000);
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0].message.length).toBeLessThan(1_000);
  });

  test('an upstream 4xx stays silent and still passes through', async () => {
    globalThis.fetch = (async () =>
      upstreamError(429, '{"error":"Rate limit exceeded"}')) as unknown as typeof fetch;

    const response = await call();

    expect(response.status).toBe(429);
    expect(await response.text()).toBe('{"error":"Rate limit exceeded"}');
    expect(refunds).toEqual(['Tool reservation refund after upstream error: firecrawl']);
    expect(warnLines).toHaveLength(0);
  });

  test('a dispatch error rethrows, refunds once, and emits no upstream warn', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(call()).rejects.toThrow('connect ECONNREFUSED');
    expect(refunds).toEqual(['Tool reservation refund after dispatch error: firecrawl']);
    expect(warnLines).toHaveLength(0);
  });

  test('the upstream 5xx wait still lands in upstream_ms for the completion log line', async () => {
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return upstreamError(500, '{"error":"Request timed out"}');
    }) as unknown as typeof fetch;

    const response = await runWithContext('POST', '/v1/router/firecrawl/v2/scrape', async () => {
      const upstreamMsBefore = upstreamMsSoFar();
      const res = await handleProxy(context, firecrawl as never, 'firecrawl');
      const recorded = upstreamMsSoFar() - upstreamMsBefore;
      expect(recorded).toBeGreaterThanOrEqual(25);
      expect(getDiagnosticFields().upstream_ms).toBe(String(Math.round(upstreamMsSoFar())));
      return res;
    });

    expect(response.status).toBe(500);
  });
});

describe('proxy upstream error diagnostics on the full Hono chain (KRTX-2073)', () => {
  test('a provider 500 on the mounted route logs once and answers once', async () => {
    globalThis.fetch = (async () =>
      upstreamError(500, '{"error":"Request timed out"}')) as unknown as typeof fetch;

    const app = new Hono();
    app.use('*', (c, next) => runWithContext('POST', c.req.path, () => next()));
    app.all('/v1/router/firecrawl/*', (c) => handleProxy(c, firecrawl as never, 'firecrawl'));

    const response = await app.request('https://api.example/v1/router/firecrawl/v2/scrape', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://93.184.216.34/page' }),
    });

    expect(response.status).toBe(500);
    expect(warnLines).toHaveLength(1);
  });
});
