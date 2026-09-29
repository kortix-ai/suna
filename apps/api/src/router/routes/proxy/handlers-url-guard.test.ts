import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

let reserveCalls = 0;
let forwardCalls = 0;

mock.module('../../../config', () => ({
  config: { KORTIX_BILLING_INTERNAL_ENABLED: true },
  KORTIX_MARKUP: 1.2,
}));

mock.module('../../services/llm-reservation', () => ({
  reserveEstimatedLlmCredits: async () => null,
  settleLlmReservation: async () => undefined,
  refundLlmReservation: async () => undefined,
}));

mock.module('./helpers', () => ({
  tryAuthenticate: async () => ({ isKortixUser: true, accountId: 'acct-synthetic' }),
  buildForwardHeaders: () => new Headers({ authorization: 'Bearer provider-key' }),
  getRequestBody: async (c: { req: { raw: Request } }, method: string) =>
    method === 'GET' || method === 'HEAD' ? undefined : await c.req.raw.clone().text(),
  maybeNormalizeOpenAIResponsesInput: (_s: unknown, _m: string, _p: string, body: unknown) => body,
  // The guard sits above route matching; hand every POST/GET a matching route
  // so the request flows into the mocked reservation and forward steps.
  matchAllowedRoute: (method: string) =>
    method === 'POST' || method === 'GET' ? { path: '/v1/scrape', methods: ['POST', 'GET'] } : null,
  reserveToolProxyCredits: async () => {
    reserveCalls += 1;
    return null;
  },
  refundToolReservation: async () => undefined,
  injectApiKey: (_s: unknown, _h: Headers, body: unknown) => body,
}));

const { handleProxy } = await import('./handlers');
const originalFetch = globalThis.fetch;

const firecrawlService = {
  name: 'firecrawl',
  targetBaseUrl: 'https://firecrawl.example',
  getKortixApiKey: () => 'fc-synthetic-key',
  keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
  billingToolName: 'proxy_firecrawl',
} as never;

/**
 * Mount handleProxy the way routes.ts does, with the API's global error shape
 * (src/index.ts app.onError): an HTTPException answers
 * `{ error: true, message, status }` with its status.
 */
function createTestApp() {
  const app = new Hono();
  app.all('/v1/router/firecrawl/*', (c) => handleProxy(c, firecrawlService, 'firecrawl'));
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: true, message: error.message, status: error.status }, error.status);
    }
    throw error;
  });
  return app;
}

const app = createTestApp();
const BASE = 'https://api.example/v1/router/firecrawl';

function scrape(method: string, path: string, body?: string) {
  return app.request(`${BASE}${path}`, {
    method,
    body: body === undefined ? undefined : body,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  reserveCalls = 0;
  forwardCalls = 0;
  globalThis.fetch = mock(async () => {
    forwardCalls += 1;
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

describe('firecrawl proxy SSRF URL guard', () => {
  test.each([
    ['loopback IPv4', 'http://127.0.0.1:8080/secret'],
    ['loopback via numeric host', 'http://2130706433/'],
    ['loopback via octal host', 'http://0177.0.0.1/'],
    ['cloud metadata IPv4', 'http://169.254.169.254/latest/meta-data/'],
    ['RFC1918 10/8', 'http://10.1.2.3/'],
    ['RFC1918 172.16/12', 'http://172.16.5.4/'],
    ['RFC1918 192.168/16', 'http://192.168.0.10/'],
    ['IPv6 loopback', 'http://[::1]/x'],
    ['IPv6 ULA', 'http://[fd12:3456:789a::1]/x'],
    ['IPv4-mapped IPv6 metadata', 'http://[::ffff:169.254.169.254]/latest/meta-data/'],
    ['localhost hostname', 'http://localhost:5678/'],
    ['localhost subdomain', 'http://app.localhost/'],
    ['mDNS .local host', 'http://printer.local/'],
    ['cloud metadata hostname', 'https://metadata.google.internal/computeMetadata/v1/'],
    [
      'internal .internal host',
      'http://instance-data.us-east-1.compute.internal/latest/meta-data/',
    ],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://example.com/file.txt'],
  ])('rejects %s with 400 before the credit gate', async (_label, target) => {
    const res = await scrape('POST', '/v1/scrape', JSON.stringify({ url: target }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: true,
      message: expect.any(String),
      status: 400,
    });
    expect(reserveCalls).toBe(0);
    expect(forwardCalls).toBe(0);
  });

  test.each(['v1/scrape', 'v2/scrape', 'v1/crawl', 'v2/map', 'v1/search'])(
    'guards %s too',
    async (route) => {
      const res = await scrape(
        'POST',
        `/${route}`,
        JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
      );
      expect(res.status).toBe(400);
      expect(forwardCalls).toBe(0);
    },
  );

  test('forwards a public URL past validation to the credit gate and upstream', async () => {
    const res = await scrape(
      'POST',
      '/v1/scrape',
      JSON.stringify({ url: 'https://kortix.com/docs' }),
    );
    expect(res.status).toBe(200);
    expect(reserveCalls).toBe(1);
    expect(forwardCalls).toBe(1);
  });

  test('allows a plain http public URL', async () => {
    const res = await scrape('POST', '/v1/scrape', JSON.stringify({ url: 'http://example.com/' }));
    expect(res.status).toBe(200);
    expect(reserveCalls).toBe(1);
    expect(forwardCalls).toBe(1);
  });

  test('leaves a body without a url field untouched (firecrawl search)', async () => {
    const res = await scrape('POST', '/v1/search', JSON.stringify({ query: 'synthetic query' }));
    expect(res.status).toBe(200);
    expect(reserveCalls).toBe(1);
    expect(forwardCalls).toBe(1);
  });

  test('does not guard the bodyless crawl status GET', async () => {
    const res = await scrape('GET', '/v1/crawl/job-123');
    expect(res.status).toBe(200);
    expect(reserveCalls).toBe(1);
    expect(forwardCalls).toBe(1);
  });
});
