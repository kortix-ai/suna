import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The Firecrawl proxy forwards a caller-supplied `url` body field to its
 * fetcher. These tests pin the API-layer SSRF guard: a loopback / link-local
 * (cloud metadata) / RFC1918 / ULA / non-http(s) target is rejected with 400
 * before the credit reservation and before any upstream fetch. A public target
 * still reaches the credit gate and the upstream hop.
 */

let reserveCalls = 0;
let fetchCalls: string[] = [];
let currentBody = '';

mock.module('./helpers', () => ({
  tryAuthenticate: async () => ({ isKortixUser: true, accountId: 'acct-synthetic' }),
  buildForwardHeaders: () => new Headers(),
  getRequestBody: async () => currentBody,
  maybeNormalizeOpenAIResponsesInput: (
    _service: unknown,
    _method: string,
    _path: string,
    body: unknown,
  ) => body,
  matchAllowedRoute: () => ({ path: '/v1/scrape', methods: ['POST'] }),
  reserveToolProxyCredits: async () => {
    reserveCalls += 1;
    return null;
  },
  refundToolReservation: async () => undefined,
  injectApiKey: () => undefined,
}));

const { handleProxy } = await import('./handlers');
const originalFetch = globalThis.fetch;

const firecrawl = {
  name: 'firecrawl',
  targetBaseUrl: 'https://api.firecrawl.dev',
  getKortixApiKey: () => 'firecrawl-key',
  keyInjection: { type: 'header' as const, headerName: 'Authorization', prefix: 'Bearer ' },
  allowedRoutes: [],
  billingToolName: 'proxy_firecrawl',
};

function firecrawlContext(body: string) {
  return {
    req: {
      url: 'https://api.kortix.test/v1/router/firecrawl/v1/scrape',
      method: 'POST',
      header: () => undefined,
      raw: {
        clone: () => ({
          text: async () => body,
          arrayBuffer: async () => new TextEncoder().encode(body),
        }),
      },
    },
  };
}

async function call(): Promise<{ status: number }> {
  try {
    const response = await handleProxy(
      firecrawlContext(currentBody),
      firecrawl as never,
      'firecrawl',
    );
    return { status: response.status };
  } catch (error) {
    const thrown = error as { status?: number };
    return { status: thrown.status ?? 0 };
  }
}

beforeEach(() => {
  reserveCalls = 0;
  fetchCalls = [];
  currentBody = '';
  globalThis.fetch = (async (url: string) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('firecrawl proxy URL guard', () => {
  const blocked: Array<[string, string]> = [
    ['loopback IPv4', 'http://127.0.0.1:8008/'],
    ['loopback IPv6', 'http://[::1]/'],
    ['link-local cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['RFC1918 private', 'http://10.1.2.3/'],
    ['ULA IPv6', 'http://[fd00:ec2::254]/'],
    ['non-http(s) scheme', 'file:///etc/passwd'],
  ];

  for (const [label, target] of blocked) {
    test(`rejects ${label} with 400 before the credit gate and any fetch`, async () => {
      currentBody = JSON.stringify({ url: target });

      const result = await call();

      expect(result.status).toBe(400);
      expect(reserveCalls).toBe(0);
      expect(fetchCalls).toEqual([]);
    });
  }

  test('a public URL still reaches the credit gate and the upstream hop', async () => {
    currentBody = JSON.stringify({ url: 'https://93.184.216.34/page' });

    const result = await call();

    expect(result.status).toBe(200);
    expect(reserveCalls).toBe(1);
    expect(fetchCalls).toEqual(['https://api.firecrawl.dev/v1/scrape']);
  });

  test('a firecrawl request with no url body field is not blocked', async () => {
    currentBody = JSON.stringify({ query: 'firecrawl search carries no url' });

    const result = await call();

    expect(result.status).toBe(200);
    expect(reserveCalls).toBe(1);
  });
});
