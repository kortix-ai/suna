/**
 * E2E tests for Billing HTTP routes.
 *
 * Tests: account deletion (status, request, cancel, delete-immediately)
 *        and removed legacy billing route surfaces.
 *
 * Strategy:
 * - mock.module() replaces auth, services, and repositories
 * - Mount billingApp in a test Hono app with error handler
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { BillingError } from '../errors';

// ─── Mock state ──────────────────────────────────────────────────────────────

const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';

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
  apiKeyAuth: async (_c: any, next: any) => { await next(); },
  combinedAuth: async (_c: any, next: any) => { await next(); },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => TEST_USER_ID,
  resolveScopedAccountId: async () => TEST_USER_ID,
}));

// Credits service mock
mock.module('../billing/services/credits', () => ({
  getCreditSummary: async () => ({ total: 100, daily: 3, monthly: 80, extra: 20, canRun: true }),
  grantCredits: async () => {},
  resetExpiringCredits: async () => {},
  refreshDailyCredits: async () => null,
}));

// Credit accounts repository mock
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => null,
  getCreditBalance: async () => null,
  updateCreditAccount: async () => {},
  upsertCreditAccount: async () => {},
  getSubscriptionInfo: async () => null,
  getYearlyAccountsDueForRotation: async () => [],
}));

// Transactions repository mock
mock.module('../billing/repositories/transactions', () => ({
  insertLedgerEntry: async (data: any) => ({ id: 'ledger_mock', ...data }),
  getTransactions: async () => ({ rows: [], total: 0 }),
  insertPurchase: async (data: any) => ({ id: 'purchase_mock', ...data }),
  getPurchaseByPaymentIntent: async () => null,
  updatePurchaseStatus: async () => {},
}));

// Account deletion service mock
mock.module('../billing/services/account-deletion', () => ({
  getAccountDeletionStatus: async (_accountId: string) => {
    if (mockDeletionError) throw mockDeletionError;
    return mockDeletionStatus;
  },
  requestAccountDeletion: async (_accountId: string, _userId: string, _reason?: string) => {
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
  cancelAccountDeletion: async (_accountId: string) => {
    if (mockDeletionError) throw mockDeletionError;
    return mockDeletionCancelResult || { success: true, message: 'Account deletion cancelled' };
  },
  deleteAccountImmediately: async (_accountId: string) => {
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
    INTERNAL_KORTIX_ENV: 'staging',
    DATABASE_URL: '',
    FRONTEND_URL: 'http://localhost:3000',
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    ALLOWED_SANDBOX_PROVIDERS: ['local_docker'],
    getDefaultProvider: () => 'local_docker',
  },
}));

// Customers repository mock
mock.module('../billing/repositories/customers', () => ({
  listAccountStripeCustomerIds: async () => ['cus_test_123'],
  getCustomerByAccountId: async () => ({ id: 'cus_test_123', accountId: TEST_USER_ID, email: 'test@kortix.dev', provider: 'stripe', active: true }),
  getCustomerByStripeId: async () => null,
  upsertCustomer: async () => {},
  deleteCustomerByStripeId: async () => {},
}));

// Account deletion repository mock
mock.module('../billing/repositories/account-deletion', () => ({
  getActiveDeletionRequest: async () => null,
  createDeletionRequest: async () => null,
  cancelDeletionRequest: async () => {},
  markDeletionCompleted: async () => {},
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

describe('Billing: removed credit read routes', () => {
  test('legacy tier, balance, and usage summary endpoints are not mounted', async () => {
    const app = createBillingTestApp();
    const tiers = await app.request('/v1/billing/tier-configurations', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    const breakdown = await app.request('/v1/billing/credit-breakdown', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    const usage = await app.request('/v1/billing/usage-history?days=7', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });

    expect(tiers.status).toBe(404);
    expect(breakdown.status).toBe(404);
    expect(usage.status).toBe(404);
  });
});

describe('Billing: removed duplicate account-state routes', () => {
  test('legacy minimal account-state endpoint is not mounted', async () => {
    const app = createBillingTestApp();
    const minimal = await app.request('/v1/billing/account-state/minimal', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });

    expect(minimal.status).toBe(404);
  });
});

describe('Billing: removed deduction routes', () => {
  test('legacy direct deduction endpoints are not mounted', async () => {
    const app = createBillingTestApp();
    const deduct = await app.request('/v1/billing/deduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ prompt_tokens: 1, completion_tokens: 1, model: 'claude-sonnet-4.6' }),
    });
    const deductUsage = await app.request('/v1/billing/deduct-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ amount: 0.01 }),
    });

    expect(deduct.status).toBe(404);
    expect(deductUsage.status).toBe(404);
  });
});

describe('Billing: removed payment report routes', () => {
  test('legacy transaction summary and credit usage endpoints are not mounted', async () => {
    const app = createBillingTestApp();
    const summary = await app.request('/v1/billing/transactions/summary', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    const creditUsage = await app.request('/v1/billing/credit-usage', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });

    expect(summary.status).toBe(404);
    expect(creditUsage.status).toBe(404);
  });
});

describe('Billing: removed subscription checkout routes', () => {
  test('legacy inline checkout endpoints are not mounted', async () => {
    const app = createBillingTestApp();
    const createInline = await app.request('/v1/billing/create-inline-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ tier_key: 'pro', billing_period: 'monthly' }),
    });
    const confirmInline = await app.request('/v1/billing/confirm-inline-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ subscription_id: 'sub_test', tier_key: 'pro' }),
    });

    expect(createInline.status).toBe(404);
    expect(confirmInline.status).toBe(404);
  });

  test('manual checkout confirmation and proration endpoints are not mounted', async () => {
    const app = createBillingTestApp();
    const details = await app.request('/v1/billing/checkout-session/cs_test', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    const confirm = await app.request('/v1/billing/confirm-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ session_id: 'cs_test' }),
    });
    const proration = await app.request('/v1/billing/proration-preview?new_price_id=price_test', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });

    expect(details.status).toBe(404);
    expect(confirm.status).toBe(404);
    expect(proration.status).toBe(404);
  });
});

describe('Billing: removed subscription management routes', () => {
  test('legacy direct subscription management endpoints are not mounted', async () => {
    const app = createBillingTestApp();
    const cancel = await app.request('/v1/billing/cancel-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ feedback: 'test' }),
    });
    const reactivate = await app.request('/v1/billing/reactivate-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
    });
    const scheduleDowngrade = await app.request('/v1/billing/schedule-downgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ target_tier_key: 'free' }),
    });
    const cancelScheduled = await app.request('/v1/billing/cancel-scheduled-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
    });

    expect(cancel.status).toBe(404);
    expect(reactivate.status).toBe(404);
    expect(scheduleDowngrade.status).toBe(404);
    expect(cancelScheduled.status).toBe(404);
  });
});

describe('Billing: webhooks', () => {
  test('POST /v1/billing/webhooks/stripe remains public and signature-checked', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/webhooks/stripe', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Missing stripe-signature header');
  });

  test('legacy singular /v1/billing/webhook/stripe is not mounted', async () => {
    const app = createBillingTestApp();
    const res = await app.request('/v1/billing/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: '{}',
    });
    expect(res.status).toBe(404);
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
