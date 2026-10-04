import { describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

// The internal routes the standalone gateway pod calls, through the real Hono
// app and the real model catalog. Mocked: resolveCandidates, the servable
// project catalog (it reads the database), and the hooks' persistence.
const loggerWarn = mock(() => {});
// Swapped per-test so a test can hold the trace write open and prove the route
// does not wait for it.
const persistGatewayTraceMock = mock<(trace: unknown) => Promise<void>>(async () => {});
mock.module('../../lib/logger', () => ({
  logger: {
    warn: loggerWarn,
    info: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));
const actualBillingGate = await import('../../services/billing/services/billing-gate');
mock.module('../../services/billing/services/billing-gate', () => ({
  ...actualBillingGate,
  assertBillingActive: async () => undefined,
}));
mock.module('../../services/llm-gateway/budgets', () => ({
  checkBudget: async () => ({ exceeded: false }),
  releaseBudgetReservation: () => {},
}));
const usageEvents: unknown[] = [];
const actualHooks = await import('../../services/llm-gateway/hooks');
mock.module('../../services/llm-gateway/hooks', () => ({
  ...actualHooks,
  authenticatePrincipal: async () => null,
  authorizeRequest: async () => ({ ok: true }),
  persistGatewayTrace: persistGatewayTraceMock,
  recordGatewayUsage: async (event: unknown) => {
    usageEvents.push(event);
  },
}));
const servableCalls: unknown[] = [];
mock.module('../../services/llm-gateway/models/servable-catalog', () => ({
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
mock.module('../../services/llm-gateway/routing', () => ({
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
mock.module('../../services/llm-gateway/resolution/resolve-candidates', () => ({
  resolveCandidates: resolveCandidatesMock,
}));

const refreshCalls: unknown[] = [];
let refreshResult: { access: string; accountId?: string } | null = null;
const actualCodex = await import('../../services/llm-gateway/credentials/codex');
mock.module('../../services/llm-gateway/credentials/codex', () => ({
  ...actualCodex,
  refreshRefusedCodexAccountLogin: async (input: unknown) => {
    refreshCalls.push(input);
    return refreshResult;
  },
}));

let opencodeResult: { access: string } | null = null;
const actualOpencode = await import('../../services/llm-gateway/credentials/opencode-console');
mock.module('../../services/llm-gateway/credentials/opencode-console', () => ({
  ...actualOpencode,
  refreshRefusedOpencodeLogin: async () => opencodeResult,
}));

const { createInternalGatewayRoutes } = await import('./internal-routes');
const { gatewayModelCatalog } = await import('../../services/llm-gateway/models/catalog-models');

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
    expect(servableCalls).toEqual([{ projectId: 'p1', accountId: 'a1', principalUserId: 'u1', personalUserId: 'u1' }]);
  });

  test('a shared session keeps its member for project-wide keys and loses only personal ones', async () => {
    // personalUserId null = a shared agent-principal session. It passed null
    // as the ONLY user before, so servableProjectCatalog listed no pooled key
    // at all — a model reached through a project-wide key was missing from the
    // list the sandbox registers, and the runtime refused it.
    servableCalls.length = 0;
    await app().request(
      '/models',
      authedRequest({
        principal: { userId: 'u1', accountId: 'a1', projectId: 'p1', personalUserId: null },
        scope: 'picker',
      }),
    );
    expect(servableCalls).toEqual([{ projectId: 'p1', accountId: 'a1', principalUserId: 'u1', personalUserId: null }]);
  });

  test('scope=picker without a project principal falls back to the plain catalog', async () => {
    servableCalls.length = 0;
    const res = await app().request(
      '/models',
      authedRequest({ principal: { userId: 'u1', accountId: 'a1' }, scope: 'picker' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: gatewayModelCatalog(undefined) });
    expect(servableCalls).toEqual([]);
  });
});

// `GET /models?scope=managed` — the compact managed-lineup listing every
// sandbox fetches on boot. The managed lineup is deployment config, but each
// sandbox image bakes the catalog at template-build time, so a managed model
// added after the last build was absent from the box and OpenCode answered
// `ModelNotFound: kortix/<id>` (prod, 2026-08-19). The sandbox now learns the
// managed set from this route on every boot.
describe('POST /models managedOnly', () => {
  async function models(body: unknown): Promise<Record<string, unknown>> {
    const res = await app().request('/models', authedRequest(body));
    expect(res.status).toBe(200);
    return ((await res.json()) as { models: Record<string, unknown> }).models;
  }

  test('managedOnly serves exactly the managed lineup, no BYOK or Codex model', async () => {
    const managed = await models({
      principal: { userId: 'u', accountId: 'a', projectId: 'p', keyId: 'k' },
      managedOnly: true,
    });

    expect(Object.keys(managed).sort()).toEqual(Object.keys(gatewayModelCatalog(undefined)).sort());
    expect(Object.keys(managed).length).toBeGreaterThan(0);
    expect(Object.keys(managed).some((id) => id.includes('/'))).toBe(false);
    // ~3KB instead of ~3.3MB is the whole point of the scope.
    expect(JSON.stringify(managed).length).toBeLessThan(20_000);
  });

  test('the default response is the full project catalog, BYOK included', async () => {
    const full = await models({ principal: { userId: 'u', accountId: 'a', projectId: 'p', keyId: 'k' } });

    expect(Object.keys(full).sort()).toEqual(Object.keys(gatewayModelCatalog('p')).sort());
    expect(full['anthropic/claude-opus-4-8']).toBeDefined();
    expect(Object.keys(full).length).toBeGreaterThan(Object.keys(gatewayModelCatalog(undefined)).length);
  });

  test('a free-tier account gets an empty managed set', async () => {
    const managed = await models({
      principal: { userId: 'u', accountId: 'a', projectId: 'p', keyId: 'k', freeModelsOnly: true },
      managedOnly: true,
    });

    expect(managed).toEqual({});
  });
});

describe('POST /trace — best-effort persistence never blocks the response', () => {
  // Prod, 2026-09-28: the handler awaited the gateway_request_logs write on the
  // isolated audit pool. Under the per-session sequence-lock convoy that write
  // waited tens of seconds for one of the pool's 2 backends, so this route's
  // p95 tracked the pool's queue depth (44 s at the peak). The gateway already
  // posts the trace fire-and-forget, so the route must answer at once.
  test('answers 200 while the audit-pool write is still pending', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    persistGatewayTraceMock.mockImplementationOnce(async () => {
      await held;
    });

    const res = await Promise.race([
      app().request('/trace', authedRequest({ trace: { requestId: 'req_held' } })),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    release();

    expect(res).not.toBe('timeout');
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ ok: true });
  });

  test('a failed background write is logged and still answers 200', async () => {
    loggerWarn.mockClear();
    persistGatewayTraceMock.mockImplementationOnce(async () => {
      throw new Error('55P03 canceling statement due to lock timeout');
    });

    const res = await app().request('/trace', authedRequest({ trace: { requestId: 'req_fail' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Let the detached rejection handler run before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  test('a trace without a request id is still refused', async () => {
    const res = await app().request('/trace', authedRequest({ trace: { accountId: 'a1' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false });
  });
});

describe('POST /usage', () => {
  // The request id is the settlement's idempotency key: without it a retried
  // settlement would bill twice.
  test('a usage event without a request id is refused and never settled', async () => {
    usageEvents.length = 0;
    const res = await app().request(
      '/usage',
      authedRequest({ event: { accountId: 'a1', finalCost: 0.05 } }),
    );
    expect(res.status).toBe(400);
    expect(usageEvents).toEqual([]);

    const settled = await app().request(
      '/usage',
      authedRequest({ event: { accountId: 'a1', finalCost: 0.05, requestId: 'req_1' } }),
    );
    expect(settled.status).toBe(200);
    expect(usageEvents).toHaveLength(1);
  });
});

describe('POST /refresh-credential', () => {
  const ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const USER = '33333333-3333-4333-8333-333333333333';
  const SECRET = '44444444-4444-4444-8444-444444444444';
  const body = {
    principal: { accountId: ACCOUNT, projectId: PROJECT, userId: USER, sessionId: 'session-1' },
    secretId: SECRET,
    failedKeySha256: 'a'.repeat(64),
  };
  const post = (payload: unknown, authorization = `Bearer ${TOKEN}`) =>
    app().request('http://test/refresh-credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(payload),
    });

  test('returns only the new token and its ChatGPT headers', async () => {
    refreshCalls.length = 0;
    refreshResult = { access: 'fresh-access', accountId: 'chatgpt-acct' };
    const res = await post(body);
    expect(res.status).toBe(200);
    const { descriptor } = (await res.json()) as { descriptor: Record<string, unknown> };
    expect(Object.keys(descriptor).sort()).toEqual(['apiKey', 'headers']);
    expect(descriptor).toMatchObject({ apiKey: 'fresh-access', headers: { 'ChatGPT-Account-ID': 'chatgpt-acct' } });
    expect(refreshCalls).toEqual([{
      projectId: PROJECT, accountId: ACCOUNT, userId: USER, sessionId: 'session-1', secretId: SECRET, failedKeySha256: 'a'.repeat(64),
    }]);
  });

  test('an OpenCode Console login returns only its new token', async () => {
    refreshCalls.length = 0;
    opencodeResult = { access: 'fresh-console-token' };
    const res = await post(body);
    opencodeResult = null;
    expect(await res.json()).toEqual({ descriptor: { apiKey: 'fresh-console-token' } });
    expect(refreshCalls).toEqual([]);
  });

  test('a login that cannot be refreshed answers null', async () => {
    refreshResult = null;
    const res = await post(body);
    expect(await res.json()).toEqual({ descriptor: null });
  });

  test('refuses a malformed request and a caller without the internal token', async () => {
    refreshCalls.length = 0;
    expect((await post({ ...body, failedKeySha256: 'not-a-digest' })).status).toBe(400);
    expect((await post({ ...body, principal: { accountId: ACCOUNT, userId: USER } })).status).toBe(400);
    expect((await post(body, 'Bearer wrong')).status).toBe(401);
    expect(refreshCalls).toEqual([]);
  });
});
