import { describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

// resolveCandidates is the only internal-routes dep whose behavior matters
// here; mock it (and the logger) so the route loads in isolation without
// dragging in config/db/billing.
mock.module('../lib/logger', () => ({
  logger: {
    warn: mock(() => {}),
    info: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));
const actualBillingGate = await import('../billing/services/billing-gate');
mock.module('../billing/services/billing-gate', () => ({
  ...actualBillingGate,
  assertBillingActive: async () => undefined,
}));
mock.module('./budgets', () => ({ checkBudget: async () => ({ exceeded: false }) }));
const actualHooks = await import('./hooks');
mock.module('./hooks', () => ({
  ...actualHooks,
  authenticatePrincipal: async () => null,
  authorizeRequest: async () => ({ ok: true }),
  persistGatewayTrace: async () => {},
  recordGatewayUsage: async () => {},
}));
mock.module('./models/catalog-models', () => ({
  gatewayModelCatalog: () => ({}),
}));
const servableCalls: unknown[] = [];
mock.module('./models/servable-catalog', () => ({
  servableProjectCatalog: async (input: unknown) => {
    servableCalls.push(input);
    return {
      models: {
        'amazon-bedrock/global.openai.gpt-5.6-sol': { name: 'GPT-5.6 Sol (Global)', enabled: true },
        'grok-4.6': { name: 'Grok 4.6', enabled: false },
      },
      modelOverrides: {},
      defaultModel: 'grok-4.6',
      usingDefaults: true,
    };
  },
}));
mock.module('./routing', () => ({
  resolveGatewayRoute: async () => ({
    policyId: 'auto',
    primaryModel: 'codex/gpt-5.6-sol',
    fallbackModels: [],
    fallbackOn: 'transient',
  }),
}));

// The thrower is swapped per-test via resolveCandidatesMock.
const resolveCandidatesMock = mock<
  (principal: unknown, model: string) => Promise<unknown[]>
>();
mock.module('./resolution/resolve-candidates', () => ({
  resolveCandidates: resolveCandidatesMock,
}));

const { createInternalGatewayRoutes } = await import('./internal-routes');

const TOKEN = 'test-internal-token-aaaaaaaaaaaaaaaaaaaaaaaa';

function app() {
  process.env.GATEWAY_INTERNAL_TOKEN = TOKEN;
  return createInternalGatewayRoutes();
}

function authedRequest(body: unknown) {
  // createInternalGatewayRoutes() mounts routes at /resolve-upstream etc. — the
  // /internal/gateway prefix is added by the parent mount in wire.ts.
  return new Request('http://test/resolve-upstream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/gateway/resolve-upstream — GatewayResolutionError contract', () => {
  test('returns candidates in a 200 when resolution succeeds', async () => {
    resolveCandidatesMock.mockResolvedValueOnce([{ provider: 'openrouter' }]);
    const res = await app().request(authedRequest({ principal: { userId: 'u' }, model: 'auto' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { candidates: unknown[] };
    expect(json.candidates).toHaveLength(1);
  });

  test('returns a 200 with resolutionError (NOT a 500) when resolveCandidates throws GatewayResolutionError', async () => {
    // The "Connect Codex to use this model." spike (incident 991624588):
    // resolveCandidates throws a deliberate, user-facing resolution error for
    // a codex/* model with no connected Codex credential. The route MUST catch
    // it and return it in a 200 body — letting it propagate produces a 500 to
    // the gateway pod, a Sentry/Better Stack error event, and a 3x retry.
    resolveCandidatesMock.mockRejectedValueOnce(
      new GatewayResolutionError(
        'provider_not_connected',
        'Connect Codex to use this model.',
        'Connect your ChatGPT/Codex account in project settings, then retry.',
      ),
    );
    const res = await app().request(
      authedRequest({ principal: { userId: 'u' }, model: 'codex/gpt-5.6-sol' }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      candidates: unknown[];
      resolutionError: { code: string; message: string; suggestion: string };
    };
    expect(json.candidates).toEqual([]);
    expect(json.resolutionError).toEqual({
      code: 'provider_not_connected',
      message: 'Connect Codex to use this model.',
      suggestion: 'Connect your ChatGPT/Codex account in project settings, then retry.',
    });
  });

  test('still surfaces other (unexpected) errors as a 500 — only GatewayResolutionError is caught', async () => {
    resolveCandidatesMock.mockRejectedValueOnce(new Error('boom: real bug'));
    const res = await app().request(
      authedRequest({ principal: { userId: 'u' }, model: 'auto' }),
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /models scope=picker', () => {
  test("serves the project's servable set (same composition as /model-picker) for a project principal", async () => {
    servableCalls.length = 0;
    const res = await app().request(
      '/models',
      authedRequest({
        principal: { userId: 'u1', accountId: 'a1', projectId: 'p1' },
        scope: 'picker',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Record<string, { enabled?: boolean }> };
    expect(Object.keys(body.models)).toEqual(['amazon-bedrock/global.openai.gpt-5.6-sol', 'grok-4.6']);
    expect(body.models['grok-4.6']?.enabled).toBe(false);
    expect(servableCalls).toEqual([{ projectId: 'p1', accountId: 'a1', principalUserId: 'u1' }]);
  });

  test('scope=picker without a project principal falls back to the plain catalog', async () => {
    servableCalls.length = 0;
    const res = await app().request(
      '/models',
      authedRequest({ principal: { userId: 'u1', accountId: 'a1' }, scope: 'picker' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: {} });
    expect(servableCalls).toEqual([]);
  });
});
