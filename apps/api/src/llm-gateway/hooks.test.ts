import { beforeEach, describe, expect, mock, test } from 'bun:test';

let accountTier = 'per_seat';
let billingCalls = 0;
let livenessBound = false;
let livenessReject = false;
let usageLoadCalls = 0;
let admissionCalls = 0;
let livenessUnexpected = false;
let finalizerThrow = false;
let creditGrantCalls = 0;

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
}));

// Real `../shared/crypto` is used as-is (pure token-shape checks, no DB) — a
// 'good'/'nope' test token never matches the `kortix_gw_` prefix, so
// `isGatewayKey` naturally returns false without mocking.

mock.module('../billing/services/yolo-tokens', () => ({
  attributeYoloToken: async () => null,
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (token: string) =>
    ['good', 'worker', 'nonworker'].includes(token)
      ? {
          isValid: true, accountId: 'acct-1', userId: 'user-1', projectId: 'project-1',
          sessionId: token === 'good' ? null : `${token}-session`,
        }
      : { isValid: false },
}));

mock.module('./resolution/default-model', () => ({
  resolveDefaultModelForPrincipal: async () => undefined,
}));

mock.module('./budgets', () => ({
  checkBudget: async () => ({ exceeded: false }),
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

mock.module('../shared/usage-events', () => ({ recordUsageEvent: async () => 'usage-event-1' }));
mock.module('../billing/services/credits', () => ({
  deductForLlmUsage: async () => {},
  grantCredits: async () => { creditGrantCalls += 1; },
}));

mock.module('../shared/db', () => ({ db: {} }));
mock.module('../shared/session-costs', () => ({
  getSessionResourceUsage: async () => {
    usageLoadCalls += 1;
    return {
      total_cost: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
      cache_write_tokens: 0, total_tokens: 0, request_count: 0,
    };
  },
}));
class MockTaskLivenessLimitExceededError extends Error {}
mock.module('../projects/generated-state-store', () => ({
  TaskLivenessLimitExceededError: MockTaskLivenessLimitExceededError,
  projectTaskWorkerIsBound: async () => livenessBound,
  admitProjectTaskWorkerIteration: async () => {
    admissionCalls += 1;
    if (livenessUnexpected) throw new Error('database unavailable');
    if (livenessReject) throw new MockTaskLivenessLimitExceededError('exhausted');
    return { taskId: 'task-1', admitted: true };
  },
  finalizeProjectTaskLivenessIfExceeded: async () => {
    if (finalizerThrow) throw new Error('finalizer unavailable');
    return false;
  },
}));

const { authorizeRequest, createInProcessGatewayHooks, recordGatewayUsage } = await import('./hooks');
const { BillingGateError } = await import('../billing/services/billing-gate');

describe('authorizeRequest — billing 402 carries the real reason, not a hardcoded constant', () => {
  beforeEach(() => {
    accountTier = 'per_seat';
    billingCalls = 0;
    billingThrow = null;
    livenessBound = false;
    livenessReject = false;
    usageLoadCalls = 0;
    admissionCalls = 0;
    livenessUnexpected = false;
    finalizerThrow = false;
    creditGrantCalls = 0;
  });

  test('insufficient_credits survives the RPC boundary', async () => {
    billingThrow = () => {
      throw new BillingGateError('insufficient_credits', 0, 'Out of credits. Top up to continue.', 'acct-1');
    };
    const result = await authorizeRequest('good');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('insufficient_credits');
  });

  test('no_account survives the RPC boundary', async () => {
    billingThrow = () => {
      throw new BillingGateError('no_account', 0, 'No credit account found.', 'acct-1');
    };
    const result = await authorizeRequest('good');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('no_account');
  });

  test('subscription_required still works (not a stale default masking real gaps)', async () => {
    billingThrow = () => {
      throw new BillingGateError('subscription_required', 0, 'Subscribe to activate your seat.', 'acct-1');
    };
    const result = await authorizeRequest('good');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('subscription_required');
  });

  test('a non-BillingGateError billing failure falls back to subscription_required (unknown reason, not a crash)', async () => {
    billingThrow = () => {
      throw new Error('some other billing failure');
    };
    const result = await authorizeRequest('good');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('subscription_required');
  });

  test('a free tier wallet never receives an LLM admission hold', async () => {
    accountTier = 'free';

    const result = await authorizeRequest('good');

    expect(result.ok).toBe(true);
    expect(billingCalls).toBe(0);
    if (result.ok) {
      expect(result.principal.freeModelsOnly).toBe(true);
      expect(result.principal.billingHold).toBeUndefined();
    }
  });

  test('a paid tier keeps the LLM admission hold', async () => {
    accountTier = 'per_seat';

    const result = await authorizeRequest('good');

    expect(result.ok).toBe(true);
    expect(billingCalls).toBe(1);
    if (result.ok) {
      expect(result.principal.freeModelsOnly).toBe(false);
      expect(result.principal.billingHold).toEqual({ amountUsd: 0.01 });
    }
  });
});


describe('authorizeRequest — task worker liveness admission', () => {
  beforeEach(() => {
    accountTier = 'per_seat';
    billingThrow = null;
    livenessBound = false;
    livenessReject = false;
    usageLoadCalls = 0;
    admissionCalls = 0;
    livenessUnexpected = false;
    finalizerThrow = false;
    creditGrantCalls = 0;
  });

  test('a non-worker session skips the aggregate usage query', async () => {
    const result = await authorizeRequest('nonworker');
    expect(result.ok).toBe(true);
    expect(usageLoadCalls).toBe(0);
    expect(admissionCalls).toBe(0);
  });

  test('a bounded worker is admitted through the atomic iteration CAS', async () => {
    livenessBound = true;
    const result = await authorizeRequest('worker');
    expect(result.ok).toBe(true);
    expect(usageLoadCalls).toBe(1);
    expect(admissionCalls).toBe(1);
  });

  test('an exhausted worker is rejected before provider dispatch', async () => {
    livenessBound = true;
    livenessReject = true;
    const result = await authorizeRequest('worker');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('task_liveness_exhausted');
  });
});


describe('gateway liveness parity and billing safety', () => {
  beforeEach(() => {
    accountTier = 'per_seat'; billingThrow = null; livenessBound = true;
    livenessReject = false; livenessUnexpected = false; finalizerThrow = false;
    usageLoadCalls = 0; admissionCalls = 0; creditGrantCalls = 0;
  });

  test('the in-process budget hook performs the same worker admission CAS', async () => {
    const hooks = createInProcessGatewayHooks();
    await hooks.assertBudget!({
      accountId: 'acct-1', userId: 'user-1', projectId: 'project-1', sessionId: 'worker-session',
    });
    expect(admissionCalls).toBe(1);
  });

  test('an unexpected liveness admission error returns a denial with the held principal', async () => {
    livenessUnexpected = true;
    const result = await authorizeRequest('worker');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('task_liveness_unavailable');
      expect(result.principal?.billingHold).toEqual({ amountUsd: 0.01 });
    }
  });

  test('a finalizer failure cannot skip billing-hold reconciliation', async () => {
    finalizerThrow = true;
    await recordGatewayUsage({
      accountId: 'acct-1', actorUserId: 'user-1', projectId: 'project-1', sessionId: 'worker-session',
      provider: 'anthropic', model: 'claude-sonnet-4.6', requestId: 'req-1', streaming: false,
      promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
      upstreamCost: 0.001, finalCost: 0.001, billingMode: 'credits', billingHoldUsd: 0.01,
    });
    expect(creditGrantCalls).toBe(1);
  });
});
