import { describe, expect, mock, test } from 'bun:test';
import { createGateway, type GatewayHooks, type ModelCatalog } from '@kortix/llm-gateway';

// `GET /models?scope=managed` — the compact managed-lineup listing every
// sandbox fetches on boot.
//
// Why it exists: the managed lineup is deployment config, but each sandbox
// image bakes the catalog at template-build time. A managed model added after
// the last build is therefore absent from the box forever, and OpenCode — which
// reads provider models once, at process start — answers
// `ModelNotFound: kortix/<id>` for it (prod, 2026-08-19: grok-4.6 and
// deepseek-v4-pro-0813 returned nothing to the user). The sandbox now learns
// the managed set from this route on every boot.
//
// Two mounts serve it and both are covered here:
//   1. in-process (`/v1/llm/models`, apps/api wire.ts) → createGateway
//   2. standalone gateway pod → POST /internal/gateway/models (internal-routes)

mock.module('../lib/logger', () => ({
  logger: { warn: mock(() => {}), info: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
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
mock.module('./routing', () => ({
  resolveGatewayRoute: async () => null,
}));
mock.module('./resolution/resolve-candidates', () => ({
  resolveCandidates: async () => [],
}));

const { createInternalGatewayRoutes } = await import('./internal-routes');
const { gatewayModelCatalog } = await import('./models/catalog-models');

const TOKEN = 'test-internal-token-aaaaaaaaaaaaaaaaaaaaaaaa';

function internalApp() {
  process.env.GATEWAY_INTERNAL_TOKEN = TOKEN;
  return createInternalGatewayRoutes();
}

function modelsRequest(body: unknown) {
  return new Request('http://test/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function internalModels(body: unknown): Promise<ModelCatalog> {
  const res = await internalApp().request(modelsRequest(body));
  expect(res.status).toBe(200);
  return ((await res.json()) as { models: ModelCatalog }).models;
}

describe('POST /internal/gateway/models — managedOnly', () => {
  test('managedOnly serves EXACTLY the managed lineup, no BYOK/codex models', async () => {
    const managed = await internalModels({
      principal: { userId: 'u', accountId: 'a', projectId: 'p', keyId: 'k' },
      managedOnly: true,
    });

    expect(Object.keys(managed).sort()).toEqual(Object.keys(gatewayModelCatalog(undefined)).sort());
    expect(managed['grok-4.6']).toBeDefined();
    expect(managed['deepseek-v4-pro-0813']).toBeDefined();
    expect(managed['anthropic/claude-opus-4-8']).toBeUndefined();
    expect(managed['codex/gpt-5.6-sol']).toBeUndefined();
    // ~3KB instead of ~3.3MB is the whole point of the scope.
    expect(JSON.stringify(managed).length).toBeLessThan(20_000);
  });

  test('the default (no managedOnly) response is unchanged — full project catalog', async () => {
    const full = await internalModels({
      principal: { userId: 'u', accountId: 'a', projectId: 'p', keyId: 'k' },
    });

    expect(Object.keys(full).sort()).toEqual(Object.keys(gatewayModelCatalog('p')).sort());
    expect(full['anthropic/claude-opus-4-8']).toBeDefined();
    expect(Object.keys(full).length).toBeGreaterThan(
      Object.keys(gatewayModelCatalog(undefined)).length,
    );
  });

  test('a free-tier account still gets an EMPTY managed set', async () => {
    const managed = await internalModels({
      principal: { userId: 'u', accountId: 'a', projectId: 'p', keyId: 'k', freeModelsOnly: true },
      managedOnly: true,
    });

    expect(managed).toEqual({});
  });
});

describe('gateway.listModels — scope plumbing', () => {
  const principal = { userId: 'u1', accountId: 'a1', projectId: 'p1', keyId: 'k1' };

  function gatewayWithSpy(): {
    call: () => { seen: Array<{ managedOnly?: boolean } | undefined> };
    gateway: ReturnType<typeof createGateway>;
  } {
    const seen: Array<{ managedOnly?: boolean } | undefined> = [];
    const hooks: GatewayHooks = {
      authenticate: async (token) => (token === 'good' ? principal : null),
      resolveUpstream: async () => [],
      assertBillingActive: async () => {},
      recordUsage: async () => {},
      listModels: async (_p, opts): Promise<ModelCatalog> => {
        seen.push(opts);
        return opts?.managedOnly ? { 'grok-4.6': { name: 'Grok 4.6' } } : { 'a/b': { name: 'B' } };
      },
    };
    return { call: () => ({ seen }), gateway: createGateway(hooks, {}) };
  }

  test('passes managedOnly straight to the catalog hook', async () => {
    const { call, gateway } = gatewayWithSpy();
    const res = await gateway.listModels('Bearer good', { managedOnly: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ models: { 'grok-4.6': { name: 'Grok 4.6' } } });
    expect(call().seen).toEqual([{ managedOnly: true }]);
  });

  test('a call with no options keeps the old contract exactly', async () => {
    const { call, gateway } = gatewayWithSpy();
    const res = await gateway.listModels('Bearer good');
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ models: { 'a/b': { name: 'B' } } });
    expect(call().seen).toEqual([undefined]);
  });

  test('the scope never bypasses auth', async () => {
    const { gateway } = gatewayWithSpy();
    expect((await gateway.listModels(undefined, { managedOnly: true })).status).toBe(401);
    expect((await gateway.listModels('Bearer bad', { managedOnly: true })).status).toBe(401);
  });
});
