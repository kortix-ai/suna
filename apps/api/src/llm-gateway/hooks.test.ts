import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { tierGrantsAllModels } from '../billing/services/tiers';
let accountTier = 'credits';
let billingCalls = 0;
let budgetCalls = 0;
let budgetActions: Array<string | undefined> = [];

// authorizeRequest() is the standalone/out-of-process gateway's combined
// auth+billing+budget RPC (backs POST /internal/gateway/authorize). Before the
// ERROR-TAXONOMY fix, its 402 branch hardcoded `errorCode: 'subscription_required'`
// no matter which BillingGateReason actually tripped — this file pins that it
// now reads the real reason off `BillingGateError` (see billing-gate.ts).
//
// Everything except the billing gate is mocked to a "happy path" stub so the
// only thing under test is the catch block's error-code selection.

mock.module('../config', () => ({
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return true;
        // Read eagerly at module scope by ../llm-gateway/routing/index.ts (a
        // transitive import of ./hooks via resolveGatewayRoute) — not
        // exercised by authorizeRequest itself, but must not blow up on import.
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        return target[key];
      },
    },
  ),
}));

mock.module('../billing/services/entitlements', () => ({
  accountHasEntitlement: async () => false,
  getCachedAccountTier: async () => accountTier,
  // Mirrors the real resolver's tier-derived default (no operator override in
  // these fixtures). Uses the REAL tiers helper so 'none' vs managed-model
  // tier semantics can't drift from production.
  accountMayUseManagedModels: async () => tierGrantsAllModels(accountTier),
}));

// Real `../shared/crypto` is used as-is (pure token-shape checks, no DB) — a
// 'good'/'nope' test token never matches the `kortix_gw_` prefix, so
// `isGatewayKey` naturally returns false without mocking.

mock.module('../billing/services/yolo-tokens', () => ({
  attributeYoloToken: async () => null,
}));

// The gateway-key and account-token refusals are mutable per test: `null`
// means "no row matches this token" (the unattributable case).
let gatewayKeyValidation: (token: string) => unknown = () => null;
let accountTokenExtra: Record<string, unknown> | null = null;

mock.module('./gateway-keys', () => ({
  INTERNAL_SESSION_TITLE_KEY_NAME: 'internal-session-title',
  createGatewayKey: async () => {
    throw new Error('not used in this test');
  },
  listGatewayKeys: async () => [],
  deleteGatewayKey: async () => false,
  revokeGatewayKey: async () => false,
  validateGatewayKey: async (token: string) => gatewayKeyValidation(token),
}));

// 'good' is a PROJECT-SCOPED token (projectId set) — the shape every admitted
// inference principal must have. 'pat' is a full-account PAT: it authenticates
// against the account but resolves with no projectId, which is exactly the
// KRTX-2295 shape.
mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (token: string) =>
    token === 'good'
      ? { isValid: true, accountId: 'acct-1', userId: 'user-1', projectId: 'proj-1', sessionId: null }
      : token === 'pat'
        ? { isValid: true, accountId: 'acct-1', userId: 'user-1', projectId: null, sessionId: null }
        : { isValid: false, ...(accountTokenExtra ?? {}) },
}));

// The order of the trace row write and the budget checks, per test.
let calls: string[] = [];

// Settlement stops at the usage write, after it names the row's route.
mock.module('../shared/usage-events', () => ({
  recordUsageEvent: async (row: { route: string }) => {
    calls.push(`usage row ${row.route}`);
    throw new Error('usage write not under test');
  },
}));

mock.module('../shared/gateway-logs', () => ({
  recordGatewayTrace: async () => {
    calls.push('trace row');
  },
}));

mock.module('./resolution/default-model', () => ({
  resolveDefaultModelForPrincipal: async () => undefined,
}));

mock.module('./budgets', () => ({
  checkBudget: async (_principal: unknown, action?: string) => {
    budgetCalls += 1;
    budgetActions.push(action);
    calls.push(`checkBudget ${action ?? 'block'}`);
    return { exceeded: false };
  },
  releaseBudgetReservation: () => {},
}));

// A minimal stand-in for the real `BillingGateError` (HTTPException + `.reason`)
// — hooks.ts's `err instanceof BillingGateError` check resolves against
// WHATEVER this mocked module exports, so the test constructs instances of
// this exact class rather than the real one.
class MockBillingGateError extends Error {
  constructor(readonly reason: string, readonly balance: number, message: string) {
    super(message);
    this.name = 'BillingGateError';
  }
}

let billingThrow: (() => never) | null = null;
mock.module('../billing/services/billing-gate', () => ({
  BillingGateError: MockBillingGateError,
  assertBillingActive: async () => {
    billingCalls += 1;
    if (billingThrow) billingThrow();
    return { holdUsd: 0.01 };
  },
}));

const { authorizeRequest, assertLlmBillingActive, authenticatePrincipal, recordGatewayUsage, persistGatewayTrace } =
  await import('./hooks');
const { BillingGateError } = await import('../billing/services/billing-gate');

describe('authorizeRequest — billing 402 carries the real reason, not a hardcoded constant', () => {
  beforeEach(() => {
    accountTier = 'credits';
    billingCalls = 0;
    budgetCalls = 0;
    billingThrow = null;
  });

  test.each([
    ['insufficient_credits', 'Out of credits. Top up to continue.'],
    ['no_account', 'No credit account found.'],
    ['subscription_required', 'Subscribe to activate your plan.'],
  ] as const)('%s survives the RPC boundary', async (reason, message) => {
    billingThrow = () => {
      throw new BillingGateError(reason, 0, message, 'acct-1');
    };
    const result = await authorizeRequest('good');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe(reason);
  });

  test('a non-BillingGateError billing failure falls back to subscription_required (unknown reason, not a crash)', async () => {
    billingThrow = () => {
      throw new Error('some other billing failure');
    };
    const result = await authorizeRequest('good');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('subscription_required');
  });

  // `none` and `free` are the plans without managed models.
  test.each(['none', 'free'])('the %s tier (no managed models) never receives an LLM admission hold', async (tier) => {
    accountTier = tier;

    const result = await authorizeRequest('good');

    expect(result.ok).toBe(true);
    expect(billingCalls).toBe(0);
    if (result.ok) {
      expect(result.principal.freeModelsOnly).toBe(true);
      expect(result.principal.billingHold).toBeUndefined();
    }
  });

  test('the credits tier keeps the LLM admission hold', async () => {
    accountTier = 'credits';

    const result = await authorizeRequest('good');

    expect(result.ok).toBe(true);
    expect(billingCalls).toBe(1);
    if (result.ok) {
      expect(result.principal.freeModelsOnly).toBe(false);
      expect(result.principal.billingHold).toEqual({ amountUsd: 0.01 });
    }
  });

  test('a new gateway defers the paid-tier hold until model resolution', async () => {
    accountTier = 'credits';

    const result = await authorizeRequest('good', { deferBilling: true });

    expect(result.ok).toBe(true);
    expect(billingCalls).toBe(0);
    if (result.ok) expect(result.principal.billingHold).toBeUndefined();
  });
});

describe('authorizeRequest — a refused token that still matches a known credential attributes its refusal', () => {
  // KRTX-1749 follow-through: the 401 branch used to drop every identity, so a
  // revoked gateway key or a dead PAT was invisible in usage and logs. The
  // denial now carries the credential row's identity when the presented secret
  // still hash-matches one; a token matching NO row stays unattributed.
  beforeEach(() => {
    gatewayKeyValidation = () => null;
    accountTokenExtra = null;
  });

  test('a revoked gateway key denies 401 with its account, project and key attached', async () => {
    gatewayKeyValidation = () => ({
      accountId: 'acct-1',
      projectId: 'proj-1',
      userId: 'user-1',
      keyId: 'key-1',
      refused: 'revoked',
    });
    const result = await authorizeRequest('kortix_gw_revoked');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.errorCode).toBe('invalid_token');
      expect(result.principal).toBeDefined();
      expect(result.principal?.accountId).toBe('acct-1');
      expect(result.principal?.projectId).toBe('proj-1');
      expect(result.principal?.keyId).toBe('key-1');
    }
  });

  test('a dead PAT denies 401 with its account attached', async () => {
    accountTokenExtra = {
      error: 'token t_1 is revoked',
      refusedIdentity: { accountId: 'acct-2', userId: 'user-2', tokenId: 't_1', projectId: null, sessionId: null },
    };
    const result = await authorizeRequest('kortix_pat_dead');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.principal).toBeDefined();
      expect(result.principal?.accountId).toBe('acct-2');
      expect(result.principal?.userId).toBe('user-2');
    }
  });

  test('a token matching no row denies 401 without a principal — unattributable stays unrecorded', async () => {
    const result = await authorizeRequest('kortix_gw_garbage');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.errorCode).toBe('invalid_token');
      expect(result.principal).toBeUndefined();
    }
  });
});

// KRTX-2295: budgets are project-scoped (gateway_budgets.projectId NOT NULL,
// checkBudget returns { exceeded: false } without a projectId) and metered
// usage lands on a project — so a full-account PAT (projectId undefined) used
// to sail through every budget gate and settle usage with projectId NULL.
// authorizeRequest must refuse inference for a project-less principal BEFORE
// the billing gate; /v1/llm/models keeps authenticating account PATs via
// authenticatePrincipal.
describe('authorizeRequest — a project-less principal cannot run inference (KRTX-2295)', () => {
  beforeEach(() => {
    accountTier = 'per_seat';
    billingCalls = 0;
    budgetCalls = 0;
    billingThrow = null;
  });

  test('a full-account PAT is refused with 403 project_required', async () => {
    const result = await authorizeRequest('pat');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.errorCode).toBe('project_required');
      expect(result.message).toMatch(/project/i);
    }
  });

  test('the refusal precedes the billing gate and the budget query', async () => {
    await authorizeRequest('pat');

    expect(billingCalls).toBe(0);
    expect(budgetCalls).toBe(0);
  });

  test('the refusal also holds on the deferred-billing path', async () => {
    const result = await authorizeRequest('pat', { deferBilling: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('project_required');
  });

  test('/v1/llm/models keeps authenticating a full-account PAT (authenticatePrincipal)', async () => {
    const principal = await authenticatePrincipal('pat');

    expect(principal).not.toBeNull();
    expect(principal?.accountId).toBe('acct-1');
    expect(principal?.projectId).toBeUndefined();
  });
});

describe('assertLlmBillingActive — the wallet floor follows the credits request, not just the entitlement', () => {
  beforeEach(() => {
    accountTier = 'credits';
    billingCalls = 0;
  });

  test('an entitlement-less account skips the gate for a request that spends nothing', async () => {
    accountTier = 'none';

    await assertLlmBillingActive('acct-1');

    expect(billingCalls).toBe(0);
  });

  // The second managed-models gate: only managed models bill credits, so a
  // Kortix-billed request from an account without the entitlement is refused
  // at admission even if model resolution let it through.
  test.each(['none', 'free'])('a Kortix-billed request from the %s plan is refused at admission', async (tier) => {
    accountTier = tier;

    await expect(assertLlmBillingActive('acct-1', { creditsRequest: true })).rejects.toMatchObject({
      reason: 'plan_upgrade_required',
    });
    expect(billingCalls).toBe(0);
  });

  test('a Kortix-billed request still gates when the account is entitled', async () => {
    await assertLlmBillingActive('acct-1', { creditsRequest: true });

    expect(billingCalls).toBe(1);
  });
});

describe('warn budgets run after the trace row is written, not at admission', () => {
  const usage = { promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 };
  const settled = {
    accountId: 'acct-1',
    actorUserId: 'user-1',
    projectId: 'proj-1',
    provider: 'kortix',
    model: 'm',
    ...usage,
    upstreamCost: 0.01,
    finalCost: 0.01,
    billingMode: 'credits' as const,
    streaming: true,
    requestId: 'req-1',
  };
  const trace = {
    requestId: 'req-1',
    startedAt: new Date(0).toISOString(),
    accountId: 'acct-1',
    actorUserId: 'user-1',
    projectId: 'proj-1',
    requestedModel: 'm',
    resolvedModel: 'm',
    provider: 'kortix',
    billingMode: 'credits' as const,
    streaming: true,
    status: 200,
    ok: true,
    latencyMs: 1,
    attempts: 1,
    candidatesTried: ['kortix'],
    usage,
    upstreamCost: 0.01,
    finalCost: 0.01,
    request: {},
    response: {},
    metadata: {},
  };

  beforeEach(() => {
    budgetActions = [];
    calls = [];
    billingThrow = null;
  });

  test('admission evaluates block budgets only', async () => {
    expect((await authorizeRequest('good', { deferBilling: true })).ok).toBe(true);
    expect(budgetActions).toEqual([undefined]);
  });

  // The spend query reads gateway_request_logs. The check must run after this
  // request's row exists, or the request that crosses a threshold is not counted.
  test('a persisted trace evaluates the warn budgets after its row is written', async () => {
    await persistGatewayTrace(trace);
    expect(calls).toEqual(['trace row', 'checkBudget warn']);
  });

  test('a trace that adds no spend evaluates nothing', async () => {
    await persistGatewayTrace({ ...trace, ok: false, status: 502, upstreamCost: 0, finalCost: 0 });
    expect(calls).toEqual(['trace row']);
  });

  test('the usage write evaluates no budget: its trace row does not exist yet', async () => {
    await recordGatewayUsage(settled).catch(() => {});
    expect(budgetActions).toEqual([]);
  });
});

// The usage event names the image operation; the usage row takes its route
// at write time. A trace never touches the usage row.
describe('the usage row names the gateway route that served the request', () => {
  const usage = { promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 };
  const usageEvent = {
    ...usage, accountId: 'acct-1', actorUserId: 'user-1', provider: 'openai', model: 'gpt-5.5',
    upstreamCost: 0, finalCost: 0, billingMode: 'none' as const, streaming: true, requestId: 'req-chat',
  };
  const trace = {
    requestId: 'req-img',
    startedAt: new Date(0).toISOString(),
    accountId: 'acct-1',
    actorUserId: 'user-1',
    projectId: 'proj-1',
    requestedModel: 'auto',
    resolvedModel: 'xai/grok-imagine-image',
    provider: 'xai',
    billingMode: 'none' as const,
    streaming: false,
    status: 200,
    ok: true,
    latencyMs: 1,
    attempts: 1,
    candidatesTried: ['xai'],
    usage,
    upstreamCost: 0,
    finalCost: 0,
    request: null,
    response: null,
    metadata: {},
  };

  beforeEach(() => {
    calls = [];
  });

  test('an image usage event is recorded with the images route', async () => {
    await recordGatewayUsage({ ...usageEvent, requestId: 'req-img', operation: 'images.generations' }).catch(() => {});
    await recordGatewayUsage({ ...usageEvent, requestId: 'req-edit', operation: 'images.edits' }).catch(() => {});
    expect(calls).toEqual(['usage row /v1/llm/images/generations', 'usage row /v1/llm/images/edits']);
  });

  test('a chat usage event keeps the chat route', async () => {
    await recordGatewayUsage(usageEvent).catch(() => {});
    await persistGatewayTrace({ ...trace, requestId: 'req-chat', streaming: true });
    expect(calls).toEqual(['usage row /v1/llm/chat/completions', 'trace row']);
  });

  test('an image trace writes only the trace row', async () => {
    await persistGatewayTrace({ ...trace, metadata: { operation: 'images.generations' } });
    expect(calls).toEqual(['trace row']);
  });
});
