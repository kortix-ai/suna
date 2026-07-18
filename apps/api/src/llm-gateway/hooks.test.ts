import { describe, expect, mock, test } from 'bun:test';

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
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return false;
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

// Real `../shared/crypto` is used as-is (pure token-shape checks, no DB) — a
// 'good'/'nope' test token never matches the `kortix_gw_` prefix, so
// `isGatewayKey` naturally returns false without mocking.

mock.module('../billing/services/yolo-tokens', () => ({
  attributeYoloToken: async () => null,
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (token: string) =>
    token === 'good'
      ? { isValid: true, accountId: 'acct-1', userId: 'user-1', projectId: null, sessionId: null }
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
    if (billingThrow) billingThrow();
  },
}));

const { authorizeRequest } = await import('./hooks');
const { BillingGateError } = await import('../billing/services/billing-gate');

describe('authorizeRequest — billing 402 carries the real reason, not a hardcoded constant', () => {
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
});
