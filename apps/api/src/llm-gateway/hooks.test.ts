import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { tierGrantsAllModels } from '../billing/services/tiers';
let accountTier = 'credits';
let billingCalls = 0;
let budgetCalls = 0;

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
  // these fixtures). Uses the REAL tiers helper so 'free' vs paid semantics
  // can't drift from production.
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

mock.module('./resolution/default-model', () => ({
  resolveDefaultModelForPrincipal: async () => undefined,
}));

mock.module('./budgets', () => ({
  checkBudget: async () => {
    budgetCalls += 1;
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

const { authorizeRequest, assertLlmBillingActive, authenticatePrincipal } = await import('./hooks');
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
    accountTier = 'free';

    await assertLlmBillingActive('acct-1');

    expect(billingCalls).toBe(0);
  });

  // KRTX-1067: the platform default is the ONE managed model an
  // entitlement-less account can run, and it settles as credits — so the
  // deferred gateway path (which calls this only for a Kortix-billed request
  // it already resolved) must take the admission hold for it too. Without
  // this, a drained free wallet runs platform-default turns with no floor and
  // the settle drives the balance negative.
  test('a Kortix-billed request takes the hold for an entitlement-less account', async () => {
    accountTier = 'free';

    await assertLlmBillingActive('acct-1', { creditsRequest: true });

    expect(billingCalls).toBe(1);
  });

  test('a Kortix-billed request still gates when the account is entitled', async () => {
    await assertLlmBillingActive('acct-1', { creditsRequest: true });

    expect(billingCalls).toBe(1);
  });
});
