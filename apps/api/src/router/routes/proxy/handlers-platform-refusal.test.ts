import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { runWithContext } from '../../../lib/request-context';

// KRTX-3022: a session's web search answered `432 {"detail":{"error":"This
// request exceeds your plan's set usage limit. Please upgrade your plan or
// contact support@tavily.com"}}`. The plan was Kortix's: every session searches
// through this proxy with the Kortix-owned key. The user was told to upgrade a
// plan they do not have, and nothing was logged, so the outage was silent.
// A provider's refusal of the Kortix key now answers as Kortix, and logs.

const errorLines: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
const refunds: string[] = [];
let authMode: 'kortix-key' | 'own-key' = 'kortix-key';

mock.module('../../../config', () => ({
  config: { KORTIX_BILLING_INTERNAL_ENABLED: true },
}));

mock.module('./helpers', () => ({
  tryAuthenticate: async () =>
    authMode === 'kortix-key'
      ? { isKortixUser: true, accountId: 'acct-synthetic' }
      : { isKortixUser: true, isPassthrough: true, accountId: 'acct-synthetic' },
  buildForwardHeaders: () => new Headers(),
  getRequestBody: async () => JSON.stringify({ query: 'desk cable tray' }),
  matchAllowedRoute: () => ({ path: '/search', methods: ['POST'] }),
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
    warn: () => {},
    error: (message: string, context?: Record<string, unknown>) => {
      errorLines.push({ message, context });
    },
  },
}));

const { handleProxy } = await import('./handlers');

const originalFetch = globalThis.fetch;

const tavily = {
  name: 'tavily',
  targetBaseUrl: 'https://api.tavily.com',
  getKortixApiKey: () => 'kortix-managed-key',
  keyInjection: { type: 'json_body_field' as const, field: 'api_key' },
  allowedRoutes: [{ path: '/search', methods: ['POST'] }],
  billingToolName: 'proxy_tavily',
};

const context = {
  req: { url: 'https://api.example/v1/router/tavily/search', method: 'POST', header: () => undefined },
} as never;

const TAVILY_PLAN_LIMIT =
  '{"detail":{"error":"This request exceeds your plan\'s set usage limit. Please upgrade your plan or contact support@tavily.com"}}';

function upstream(status: number, body: string, headers: Record<string, string> = {}) {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json', ...headers } })) as unknown as typeof fetch;
}

const call = () =>
  runWithContext('POST', '/v1/router/tavily/search', () => handleProxy(context, tavily as never, 'tavily'));

beforeEach(() => {
  errorLines.length = 0;
  refunds.length = 0;
  authMode = 'kortix-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("a provider refusing Kortix's own key (KRTX-3022)", () => {
  test("a plan limit on Kortix's key answers 503 as Kortix: not the caller's account, nothing to change", async () => {
    upstream(432, TAVILY_PLAN_LIMIT);

    const response = await call();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body.error).toBe('tool_unavailable');
    expect(body.service).toBe('tavily');
    expect(body.upstream_status).toBe(432);
    expect(String(body.message)).toContain('Web search is unavailable right now');
    expect(String(body.message)).toContain('not a limit on your account');
    expect(JSON.stringify(body)).not.toContain('upgrade your plan');
    // Not billed.
    expect(refunds).toEqual(['Tool reservation refund after upstream error: tavily']);
  });

  test('it logs one error line that names the service and the status, so the outage is seen', async () => {
    upstream(432, TAVILY_PLAN_LIMIT);

    await call();

    expect(errorLines).toHaveLength(1);
    expect(errorLines[0].message).toContain('tavily');
    expect(errorLines[0].message).toContain('432');
    expect(errorLines[0].context?.upstream_status).toBe(432);
  });

  test('no credit (402) and a rate limit (429) are the same answer; a Retry-After survives', async () => {
    upstream(402, '{"error":"Insufficient credits"}');
    expect((await call()).status).toBe(503);

    upstream(429, '{"error":"Too many requests"}', { 'Retry-After': '30' });
    const limited = await call();
    expect(limited.status).toBe(503);
    expect(limited.headers.get('retry-after')).toBe('30');
  });

  test('a refused key (401) says the provider is not accepting Kortix right now', async () => {
    upstream(401, '{"detail":{"error":"Unauthorized: missing or invalid API key."}}');

    const response = await call();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(String(body.message)).toContain('Web search is unavailable right now');
    expect(String(body.message)).toContain('not a limit on your account');
  });

  test("the caller's own key keeps the provider's answer: that plan is theirs", async () => {
    authMode = 'own-key';
    upstream(432, TAVILY_PLAN_LIMIT);

    const response = await call();

    expect(response.status).toBe(432);
    expect(await response.text()).toBe(TAVILY_PLAN_LIMIT);
    expect(errorLines).toHaveLength(0);
  });

  test("a bad request (400) and a refused target (403) are about the request, and pass through", async () => {
    upstream(400, '{"detail":{"error":"Query is too long."}}');
    expect((await call()).status).toBe(400);

    upstream(403, '{"error":"This website is no longer supported"}');
    expect((await call()).status).toBe(403);
    expect(errorLines).toHaveLength(0);
  });
});
