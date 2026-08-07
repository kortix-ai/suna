import { beforeEach, describe, expect, mock, test } from 'bun:test';

let accountTier = 'per_seat';
let billingCalls = 0;
let livenessBound = false;
let spawnedUnbound = false;
let livenessReject = false;
let usageLoadCalls = 0;
let admissionCalls = 0;
let livenessUnexpected = false;
let finalizerThrow = false;
let usageEventThrow = false;
let settledAdmissions: Array<{ workerSessionId: string; admissionId: string }> = [];
let blockedAdmissions: Array<{ workerSessionId: string; admissionId: string; reason: string }> = [];
let requestAwareUsageInputs: unknown[] = [];
let creditGrantCalls = 0;
let walletSettlementThrow = false;
let debitInputs: unknown[] = [];
let grantInputs: unknown[][] = [];

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

mock.module('../shared/usage-events', () => ({
  recordUsageEvent: async () => {
    if (usageEventThrow) throw new Error('usage ledger unavailable');
    return 'usage-event-1';
  },
}));
mock.module('../billing/services/credits', () => ({
  deductForLlmUsage: async (input: unknown) => {
    debitInputs.push(input);
    if (walletSettlementThrow) throw new Error('wallet unavailable');
  },
  grantCredits: async (...input: unknown[]) => {
    creditGrantCalls += 1;
    grantInputs.push(input);
    if (walletSettlementThrow) throw new Error('wallet unavailable');
  },
}));

mock.module('../shared/db', () => ({ db: {} }));
const zeroUsage = () => ({
  total_cost: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
  cache_write_tokens: 0, total_tokens: 0, request_count: 0,
});
const loadMockUsage = async () => {
  usageLoadCalls += 1;
  return zeroUsage();
};
mock.module('../shared/session-costs', () => ({
  getSessionResourceUsage: loadMockUsage,
  getSessionResourceUsageIncludingCurrentRequest: async (input: unknown) => {
    usageLoadCalls += 1;
    requestAwareUsageInputs.push(input);
    return zeroUsage();
  },
}));
class MockTaskLivenessLimitExceededError extends Error {}
class MockTaskLivenessRequestInFlightError extends Error {}
class MockTaskLivenessWorkerUnboundError extends Error {}
mock.module('../projects/generated-state-store', () => ({
  TaskLivenessLimitExceededError: MockTaskLivenessLimitExceededError,
  TaskLivenessRequestInFlightError: MockTaskLivenessRequestInFlightError,
  TaskLivenessWorkerUnboundError: MockTaskLivenessWorkerUnboundError,
  projectTaskWorkerAdmissionState: async () =>
    spawnedUnbound ? 'spawned_unbound' : livenessBound ? 'bound' : 'not_worker',
  admitProjectTaskWorkerIteration: async (_db: unknown, input: { requestId: string }) => {
    admissionCalls += 1;
    if (livenessUnexpected) throw new Error('database unavailable');
    if (livenessReject) throw new MockTaskLivenessLimitExceededError('exhausted');
    return { taskId: 'task-1', admitted: true, admissionId: input.requestId };
  },
  blockProjectTaskWorkerAdmission: async (
    _db: unknown,
    input: { workerSessionId: string; admissionId: string; reason: string },
  ) => {
    blockedAdmissions.push(input);
    return true;
  },
  settleProjectTaskWorkerAdmission: async (_db: unknown, input: { workerSessionId: string; admissionId: string }) => {
    if (finalizerThrow) throw new Error('finalizer unavailable');
    settledAdmissions.push(input);
    return { settled: true };
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
    spawnedUnbound = false;
    livenessReject = false;
    usageLoadCalls = 0;
    admissionCalls = 0;
    livenessUnexpected = false;
    finalizerThrow = false;
    usageEventThrow = false;
    settledAdmissions = [];
    blockedAdmissions = [];
    requestAwareUsageInputs = [];
    creditGrantCalls = 0;
    walletSettlementThrow = false;
    debitInputs = [];
    grantInputs = [];
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
    spawnedUnbound = false;
    livenessReject = false;
    usageLoadCalls = 0;
    admissionCalls = 0;
    livenessUnexpected = false;
    finalizerThrow = false;
    usageEventThrow = false;
    settledAdmissions = [];
    blockedAdmissions = [];
    requestAwareUsageInputs = [];
    creditGrantCalls = 0;
    walletSettlementThrow = false;
    debitInputs = [];
    grantInputs = [];
  });

  test('a non-worker session skips the aggregate usage query', async () => {
    const result = await authorizeRequest('nonworker');
    expect(result.ok).toBe(true);
    expect(usageLoadCalls).toBe(0);
    expect(admissionCalls).toBe(0);
  });

  test('a spawned child fails closed until its task binding commits', async () => {
    spawnedUnbound = true;
    const result = await authorizeRequest('worker', 'req-unbound');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.errorCode).toBe('task_liveness_worker_unbound');
    }
    expect(usageLoadCalls).toBe(0);
    expect(admissionCalls).toBe(0);
  });

  test('a bounded worker is admitted through the atomic iteration CAS', async () => {
    livenessBound = true;
    const result = await authorizeRequest('worker', 'req-test');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.livenessAdmissionId).toBe('req-test');
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
    accountTier = 'per_seat'; billingThrow = null; livenessBound = true; spawnedUnbound = false;
    livenessReject = false; livenessUnexpected = false; finalizerThrow = false;
    usageEventThrow = false; settledAdmissions = []; blockedAdmissions = [];
    requestAwareUsageInputs = [];
    usageLoadCalls = 0; admissionCalls = 0; creditGrantCalls = 0;
    walletSettlementThrow = false;
    debitInputs = [];
    grantInputs = [];
  });

  test('the in-process budget hook performs the same worker admission CAS', async () => {
    const hooks = createInProcessGatewayHooks();
    const admission = await hooks.assertBudget!({
      accountId: 'acct-1', userId: 'user-1', projectId: 'project-1', sessionId: 'worker-session',
    }, 'req-in-process');
    expect(admission).toEqual({ livenessAdmissionId: 'req-in-process' });
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

  test('usage settlement releases the matching durable liveness admission', async () => {
    await recordGatewayUsage({
      accountId: 'acct-1', actorUserId: 'user-1', projectId: 'project-1', sessionId: 'worker-session',
      provider: '', model: 'unknown', requestId: 'req-release', livenessAdmissionId: 'req-release', streaming: false,
      promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
      upstreamCost: 0, finalCost: 0, billingMode: 'none',
    });
    expect(settledAdmissions).toHaveLength(1);
    expect(settledAdmissions[0]).toMatchObject({ workerSessionId: 'worker-session', admissionId: 'req-release' });
    expect(requestAwareUsageInputs).toHaveLength(1);
    expect(requestAwareUsageInputs[0]).toMatchObject({
      current: { requestId: 'req-release', requestCount: 0 },
    });
  });

  test('a bound worker blocks durably when its synchronous usage ledger write fails', async () => {
    usageEventThrow = true;
    await expect(recordGatewayUsage({
      accountId: 'acct-1', actorUserId: 'user-1', projectId: 'project-1', sessionId: 'worker-session',
      provider: 'anthropic', model: 'claude-sonnet-4.6', requestId: 'req-ledger-fail',
      livenessAdmissionId: 'req-ledger-fail', streaming: false,
      promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0,
      upstreamCost: 0.002, finalCost: 0.003, billingMode: 'none',
    })).rejects.toThrow('usage ledger unavailable');

    expect(settledAdmissions).toHaveLength(0);
    expect(requestAwareUsageInputs).toHaveLength(0);
    expect(blockedAdmissions).toHaveLength(1);
    expect(blockedAdmissions[0]).toMatchObject({
      workerSessionId: 'worker-session',
      admissionId: 'req-ledger-fail',
      reason: 'accounting unavailable: usage or wallet settlement failed',
    });
  });

  test('a non-bound usage ledger failure keeps the existing error and creates no task block', async () => {
    usageEventThrow = true;
    await expect(recordGatewayUsage({
      accountId: 'acct-1', actorUserId: 'user-1', projectId: 'project-1',
      provider: 'anthropic', model: 'claude-sonnet-4.6', requestId: 'req-non-bound', streaming: false,
      promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
      upstreamCost: 0.001, finalCost: 0.001, billingMode: 'none',
    })).rejects.toThrow('usage ledger unavailable');
    expect(blockedAdmissions).toHaveLength(0);
    expect(settledAdmissions).toHaveLength(0);
  });

  test('a wallet settlement failure blocks the worker after the synchronous usage event', async () => {
    walletSettlementThrow = true;
    await expect(recordGatewayUsage({
      accountId: 'acct-1', actorUserId: 'user-1', projectId: 'project-1', sessionId: 'worker-session',
      provider: 'anthropic', model: 'claude-sonnet-4.6', requestId: 'req-wallet-fail',
      livenessAdmissionId: 'req-wallet-fail', streaming: false,
      promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0,
      upstreamCost: 0.002, finalCost: 0.03, billingMode: 'credits', billingHoldUsd: 0.01,
    })).rejects.toThrow('wallet unavailable');

    expect(settledAdmissions).toHaveLength(0);
    expect(blockedAdmissions[0]).toMatchObject({
      admissionId: 'req-wallet-fail',
      reason: 'accounting unavailable: usage or wallet settlement failed',
    });
    expect(debitInputs[0]).toMatchObject({
      idempotencyKey: 'llm-gateway:acct-1:req-wallet-fail:settlement-debit',
    });
  });

  test('a refund retry uses one request-scoped wallet key', async () => {
    await recordGatewayUsage({
      accountId: 'acct-1', actorUserId: 'user-1', projectId: 'project-1',
      provider: '', model: 'unknown', requestId: 'req-refund', streaming: false,
      promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
      upstreamCost: 0, finalCost: 0, billingMode: 'none', billingHoldUsd: 0.01,
    });

    expect(grantInputs[0]?.[6]).toBe('llm-gateway:acct-1:req-refund:settlement-refund');
  });

  test('a finalizer failure cannot skip billing-hold reconciliation', async () => {
    finalizerThrow = true;
    await recordGatewayUsage({
      accountId: 'acct-1', actorUserId: 'user-1', projectId: 'project-1', sessionId: 'worker-session',
      provider: 'anthropic', model: 'claude-sonnet-4.6', requestId: 'req-1', livenessAdmissionId: 'req-1', streaming: false,
      promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
      upstreamCost: 0.001, finalCost: 0.001, billingMode: 'credits', billingHoldUsd: 0.01,
    });
    expect(creditGrantCalls).toBe(1);
  });
});
