/**
 * E2E tests for Billing HTTP routes.
 *
 * Tests: tier-configurations, credit-breakdown, deduct, deduct-usage,
 *        account deletion (status, request, cancel, delete-immediately).
 *
 * Strategy:
 * - mock.module() replaces auth, services, and repositories
 * - Mount billingApp in a test Hono app with error handler
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { BillingError, InsufficientCreditsError } from '../errors';

// ─── Mock state ──────────────────────────────────────────────────────────────

const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';

let mockCreditBalance: any = {
  balance: '100.0000',
  expiringCredits: '80.0000',
  nonExpiringCredits: '20.0000',
  dailyCreditsBalance: '3.00',
  tier: 'tier_6_50',
};
let mockDeductResult: any = { success: true, cost: 0.5, newBalance: 99.5, transactionId: 'tx_test_001' };
let mockDeductError: Error | null = null;
let mockTransactionsSummary: any = { totalCredits: 150, totalDebits: 50, count: 200 };

let mockDeletionStatus: any = {
  has_pending_deletion: false,
  deletion_scheduled_for: null,
  requested_at: null,
  can_cancel: false,
};
let mockDeletionRequestResult: any = null;
let mockDeletionCancelResult: any = null;
let mockDeletionDeleteResult: any = null;
let mockDeletionError: Error | null = null;

// ─── Register mocks ──────────────────────────────────────────────────────────

// Auth mock — bypass supabaseAuth, inject test user
mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', TEST_USER_ID);
    c.set('userEmail', 'test@kortix.dev');
    await next();
  },
  apiKeyAuth: async (c: any, next: any) => { await next(); },
  combinedAuth: async (c: any, next: any) => { await next(); },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => TEST_USER_ID,
}));

// Credits service mock
mock.module('../billing/services/credits', () => ({
  calculateTokenCost: (prompt: number, completion: number, model: string) => {
    // Realistic: mirrors real calculateTokenCost with TOKEN_PRICE_MULTIPLIER=1.2
    // Uses anthropic-level pricing as default (inputPer1M=3, outputPer1M=15)
    const inputCost = (prompt / 1_000_000) * 3;
    const outputCost = (completion / 1_000_000) * 15;
    return (inputCost + outputCost) * 1.2;
  },
  deductCredits: async (accountId: string, cost: number, desc: string) => {
    if (mockDeductError) throw mockDeductError;
    return mockDeductResult;
  },
  getBalance: async (accountId: string) => {
    if (!mockCreditBalance) return { balance: 0, expiring: 0, nonExpiring: 0, daily: 0 };
    return {
      balance: Number(mockCreditBalance.balance),
      expiring: Number(mockCreditBalance.expiringCredits),
      nonExpiring: Number(mockCreditBalance.nonExpiringCredits),
      daily: Number(mockCreditBalance.dailyCreditsBalance),
    };
  },
  getCreditSummary: async () => ({ total: 100, daily: 3, monthly: 80, extra: 20, canRun: true }),
  grantCredits: async () => {},
  resetExpiringCredits: async () => {},
  refreshDailyCredits: async () => null,
}));

// Credit accounts repository mock
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => mockCreditBalance ? { accountId: TEST_USER_ID, ...mockCreditBalance } : null,
  getCreditBalance: async () => mockCreditBalance,
  updateCreditAccount: async () => {},
  upsertCreditAccount: async () => {},
  updateBalance: async () => {},
  getSubscriptionInfo: async () => null,
  getYearlyAccountsDueForRotation: async () => [],
}));

// Transactions repository mock
mock.module('../billing/repositories/transactions', () => ({
  insertLedgerEntry: async (data: any) => ({ id: 'ledger_mock', ...data }),
  getTransactions: async () => ({ rows: [], total: 0 }),
  getTransactionsSummary: async () => mockTransactionsSummary,
  getUsageRecords: async () => ({ rows: [], total: 0 }),
  insertPurchase: async (data: any) => ({ id: 'purchase_mock', ...data }),
  getPurchaseByPaymentIntent: async () => null,
  updatePurchaseStatus: async () => {},
}));

// Account deletion service mock
mock.module('../billing/services/account-deletion', () => ({
  getAccountDeletionStatus: async (accountId: string) => {
    if (mockDeletionError) throw mockDeletionError;
    return mockDeletionStatus;
  },
  requestAccountDeletion: async (accountId: string, userId: string, reason?: string) => {
    if (mockDeletionError) throw mockDeletionError;
    return mockDeletionRequestResult || {
      id: 'del_test_001',
      success: true,
      message: 'Account deletion scheduled successfully',
      deletion_scheduled_for: new Date(Date.now() + 14 * 86400000).toISOString(),
      can_cancel: true,
      grace_period_days: 14,
    };
  },
  cancelAccountDeletion: async (accountId: string) => {
    if (mockDeletionError) throw mockDeletionError;
    return mockDeletionCancelResult || { success: true, message: 'Account deletion cancelled' };
  },
  deleteAccountImmediately: async (accountId: string) => {
    if (mockDeletionError) throw mockDeletionError;
    return mockDeletionDeleteResult || { success: true, message: 'Account deleted' };
  },
}));

// Supabase + Stripe mocks (prevent imports from failing)
mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: null }, error: 'mocked' }) },
  }),
}));

mock.module('../shared/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: () => ({}) },
    subscriptions: { retrieve: async () => ({}), update: async () => ({}), create: async () => ({}), cancel: async () => ({}) },
    customers: { create: async () => ({ id: 'cus_test' }) },
    checkout: { sessions: { create: async () => ({}), retrieve: async () => ({}) } },
    billingPortal: { sessions: { create: async () => ({}) } },
    promotionCodes: { list: async () => ({ data: [] }) },
    invoices: { retrieveUpcoming: async () => ({}) },
    subscriptionSchedules: { create: async () => ({}), update: async () => ({}), retrieve: async () => ({}), release: async () => ({}) },
  }),
}));

mock.module('../config', () => ({
  config: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    ENV_MODE: 'cloud',
    INTERNAL_KORTIX_ENV: 'staging',
    DATABASE_URL: '',
    FRONTEND_URL: 'http://localhost:3000',
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    ALLOWED_SANDBOX_PROVIDERS: ['local_docker'],
    isLocal: () => false,
    isCloud: () => true,
    isDaytonaEnabled: () => false,
    isLocalDockerEnabled: () => false,
    getDefaultProvider: () => 'local_docker',
  },
}));

// Customers repository mock
mock.module('../billing/repositories/customers', () => ({
  getCustomerByAccountId: async () => ({ id: 'cus_test_123', accountId: TEST_USER_ID, email: 'test@kortix.dev', provider: 'stripe', active: true }),
  getCustomerByStripeId: async () => null,
  upsertCustomer: async () => {},
}));

// Account deletion repository mock
mock.module('../billing/repositories/account-deletion', () => ({
  getActiveDeletionRequest: async () => null,
  createDeletionRequest: async () => null,
  cancelDeletionRequest: async () => {},
  markDeletionCompleted: async () => {},
  getScheduledDeletions: async () => [],
}));

// ─── Import billing app AFTER mocks ──────────────────────────────────────────

const { billingApp } = await import('../billing/index');

// ─── Test app factory ────────────────────────────────────────────────────────

function createBillingTestApp() {
  const app = new Hono();

  app.route('/v1/billing', billingApp);

  app.onError((err, c) => {
    if (err instanceof BillingError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    console.error('[billing-test] Error:', err);
    return c.json({ error: true, message: 'Internal server error', status: 500 }, 500);
  });

  app.notFound((c) => c.json({ error: true, message: 'Not found', status: 404 }, 404));

  return app;
}

// ─── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreditBalance = {
    balance: '100.0000',
    expiringCredits: '80.0000',
    nonExpiringCredits: '20.0000',
    dailyCreditsBalance: '3.00',
    tier: 'tier_6_50',
  };
  mockDeductResult = { success: true, cost: 0.5, newBalance: 99.5, transactionId: 'tx_test_001' };
  mockDeductError = null;
  mockTransactionsSummary = { totalCredits: 150, totalDebits: 50, count: 200 };
  mockDeletionStatus = {
    has_pending_deletion: false,
    deletion_scheduled_for: null,
    requested_at: null,
    can_cancel: false,
  };
  mockDeletionRequestResult = null;
  mockDeletionCancelResult = null;
  mockDeletionDeleteResult = null;
  mockDeletionError = null;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Billing: tier-configurations', () => {
  test('GET /v1/billing/tier-configurations returns visible tiers', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/tier-configurations', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tiers).toBeDefined();
    expect(Array.isArray(body.tiers)).toBe(true);
    expect(body.tiers.length).toBeGreaterThanOrEqual(1);

    // Should include visible tiers
    const tierNames = body.tiers.map((t: any) => t.name);
    expect(tierNames).toContain('free');

    // Should NOT include hidden tiers
    expect(tierNames).not.toContain('none');

    // Verify tier structure
    const freeTier = body.tiers.find((t: any) => t.name === 'free');
    expect(freeTier.display_name).toBe('Basic');
    expect(freeTier.monthly_price).toBe(0);
    expect(freeTier.monthly_credits).toBe(0);

  });
});

describe('Billing: credit-breakdown', () => {
  test('GET /v1/billing/credit-breakdown returns balance breakdown', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/credit-breakdown', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(100);
    expect(body.expiring).toBe(80);
    expect(body.non_expiring).toBe(20);
    expect(body.daily).toBe(3);
  });

  test('returns zeros when no account found', async () => {
    mockCreditBalance = null;
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/credit-breakdown', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.expiring).toBe(0);
    expect(body.non_expiring).toBe(0);
    expect(body.daily).toBe(0);
  });
});

describe('Billing: deduct', () => {
  test('POST /v1/billing/deduct deducts credits for token usage', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/deduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({
        prompt_tokens: 1000,
        completion_tokens: 500,
        model: 'claude-sonnet-4-5',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cost).toBeDefined();
    expect(body.new_balance).toBeDefined();
    expect(body.transaction_id).toBe('tx_test_001');
  });

  test('returns success with zero cost when calculated cost is zero', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/deduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({
        prompt_tokens: 0,
        completion_tokens: 0,
        model: 'free-model',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cost).toBe(0);
  });

  test('returns error when deduction fails (insufficient credits)', async () => {
    mockDeductError = new InsufficientCreditsError(0.5, 100);
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/deduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({
        prompt_tokens: 10000000,
        completion_tokens: 10000000,
        model: 'claude-sonnet-4-5',
      }),
    });
    expect(res.status).toBe(402);
  });

  test('deducts without thread_id or message_id', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/deduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({
        prompt_tokens: 1000,
        completion_tokens: 500,
        model: 'claude-sonnet-4-5',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe('Billing: deduct-usage', () => {
  test('POST /v1/billing/deduct-usage deducts a fixed amount', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/deduct-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ amount: 0.05, description: 'Custom usage' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('returns success with zero cost for zero/negative amount', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/deduct-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ amount: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cost).toBe(0);
  });

  test('returns success with zero cost for negative amount', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/deduct-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ amount: -5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cost).toBe(0);
  });
});

describe('Billing: usage-history', () => {
  test('GET /v1/billing/usage-history returns summary', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/usage-history', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCredits).toBe(150);
    expect(body.totalDebits).toBe(50);
    expect(body.count).toBe(200);
  });

  test('accepts days query parameter', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/usage-history?days=7', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
  });
});

describe('Billing: account deletion', () => {
  test('GET /v1/billing/account/deletion-status returns no pending deletion', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/deletion-status', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_pending_deletion).toBe(false);
  });

  test('GET /v1/billing/account/deletion-status returns pending deletion', async () => {
    mockDeletionStatus = {
      has_pending_deletion: true,
      deletion_scheduled_for: '2026-03-01T00:00:00.000Z',
      requested_at: '2026-02-15T00:00:00.000Z',
      can_cancel: true,
    };
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/deletion-status', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_pending_deletion).toBe(true);
    expect(body.can_cancel).toBe(true);
    expect(body.deletion_scheduled_for).toBeDefined();
  });

  test('POST /v1/billing/account/request-deletion creates deletion request', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/request-deletion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ reason: 'Testing deletion' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.success).toBe(true);
    expect(body.deletion_scheduled_for).toBeDefined();
    expect(body.can_cancel).toBe(true);
    expect(body.grace_period_days).toBe(14);
  });

  test('POST /v1/billing/account/request-deletion works without reason', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/request-deletion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  test('POST /v1/billing/account/request-deletion returns error when already pending', async () => {
    mockDeletionError = new BillingError('Active deletion request already exists', 400);
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/request-deletion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('POST /v1/billing/account/cancel-deletion cancels pending deletion', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/cancel-deletion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('POST /v1/billing/account/cancel-deletion returns error when nothing to cancel', async () => {
    mockDeletionError = new BillingError('No active deletion request found', 400);
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/cancel-deletion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(400);
  });

  test('DELETE /v1/billing/account/delete-immediately deletes account', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/account/delete-immediately', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test_token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('Account deleted');
  });
});
