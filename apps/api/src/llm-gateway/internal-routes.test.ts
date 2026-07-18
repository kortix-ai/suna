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
mock.module('../billing/services/billing-gate', () => ({
  assertBillingActive: async () => undefined,
}));
mock.module('./budgets', () => ({ checkBudget: async () => ({ exceeded: false }) }));
mock.module('./hooks', () => ({
  authenticatePrincipal: async () => null,
  authorizeRequest: async () => ({ ok: true }),
  persistGatewayTrace: async () => {},
  recordGatewayUsage: async () => {},
}));
mock.module('./models/catalog-models', () => ({
  gatewayModelCatalog: () => ({}),
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
