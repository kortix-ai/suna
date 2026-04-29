/**
 * Shared mock factories for billing unit tests.
 *
 * Uses a global mock registry so multiple test files can share
 * the same mock.module() registrations without conflicts.
 */
import { mock } from 'bun:test';

// ─── Global Mock Registry ─────────────────────────────────────────────────────

export const mockRegistry = {
  supabaseRpc: null as ReturnType<typeof createMockSupabaseRpc> | null,
  stripeClient: null as any,

  getCreditAccount: null as ((id: string) => Promise<any>) | null,
  getCreditBalance: null as ((id: string) => Promise<any>) | null,
  updateCreditAccount: null as ((id: string, data: any) => Promise<void>) | null,
  upsertCreditAccount: null as ((id: string, data: any) => Promise<void>) | null,
  getYearlyAccountsDueForRotation: null as (() => Promise<any[]>) | null,

  insertLedgerEntry: null as ((data: any) => Promise<any>) | null,
  getPurchaseByPaymentIntent: null as ((id: string) => Promise<any>) | null,
  updatePurchaseStatus: null as ((...args: any[]) => Promise<void>) | null,

  getCustomerByAccountId: null as ((id: string) => Promise<any>) | null,
  getCustomerByStripeId: null as ((id: string) => Promise<any>) | null,
  upsertCustomer: null as ((data: any) => Promise<void>) | null,

  grantCredits: null as ((...args: any[]) => Promise<void>) | null,
  resetExpiringCredits: null as ((...args: any[]) => Promise<void>) | null,

  provisionSandboxFromCheckout: null as ((...args: any[]) => Promise<any>) | null,
  resolveAccountId: null as ((userId: string) => Promise<string>) | null,

  getActiveDeletionRequest: null as ((id: string) => Promise<any>) | null,
  createDeletionRequest: null as ((...args: any[]) => Promise<any>) | null,
  cancelDeletionRequest: null as ((id: string) => Promise<void>) | null,
  markDeletionCompleted: null as ((id: string) => Promise<void>) | null,
  getScheduledDeletions: null as (() => Promise<any[]>) | null,
};

export function resetMockRegistry() {
  for (const key of Object.keys(mockRegistry) as (keyof typeof mockRegistry)[]) {
    (mockRegistry as any)[key] = null;
  }
}

// ─── Register Global Mocks (once per process) ────────────────────────────────

let _registered = false;
export function registerGlobalMocks() {
  if (_registered) return;
  _registered = true;

  mock.module('../../shared/supabase', () => ({
    getSupabase: () => ({
      rpc: (name: string, params?: any) => {
        if (mockRegistry.supabaseRpc) return mockRegistry.supabaseRpc.rpc(name, params);
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => ({
        insert: async (data: any) => ({ data: null, error: null }),
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
        upsert: async (data: any) => ({ data: null, error: null }),
      }),
    }),
  }));

  mock.module('../../shared/stripe', () => ({
    getStripe: () => mockRegistry.stripeClient ?? createMockStripeClient(),
  }));

  mock.module('../../config', () => ({
    config: {
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      ENV_MODE: 'cloud',
      INTERNAL_KORTIX_ENV: 'prod',
    },
  }));

  mock.module('../../shared/resolve-account', () => ({
    resolveAccountId: async (userId: string) =>
      mockRegistry.resolveAccountId ? mockRegistry.resolveAccountId(userId) : userId,
  }));

  mock.module('../../billing/repositories/credit-accounts', () => ({
    getCreditAccount: async (id: string) =>
      mockRegistry.getCreditAccount ? mockRegistry.getCreditAccount(id) : createMockCreditAccount(),
    getCreditBalance: async (id: string) => {
      if (mockRegistry.getCreditBalance) return mockRegistry.getCreditBalance(id);
      const a = createMockCreditAccount();
      return { balance: a.balance, expiringCredits: a.expiringCredits, nonExpiringCredits: a.nonExpiringCredits, dailyCreditsBalance: a.dailyCreditsBalance, tier: a.tier };
    },
    updateCreditAccount: async (id: string, data: any) =>
      mockRegistry.updateCreditAccount ? mockRegistry.updateCreditAccount(id, data) : undefined,
    upsertCreditAccount: async (id: string, data: any) =>
      mockRegistry.upsertCreditAccount ? mockRegistry.upsertCreditAccount(id, data) : undefined,
    updateBalance: async () => {},
    getSubscriptionInfo: async () => null,
    getYearlyAccountsDueForRotation: async () =>
      mockRegistry.getYearlyAccountsDueForRotation ? mockRegistry.getYearlyAccountsDueForRotation() : [],
  }));

  mock.module('../../billing/repositories/transactions', () => ({
    insertLedgerEntry: async (data: any) =>
      mockRegistry.insertLedgerEntry ? mockRegistry.insertLedgerEntry(data) : { id: 'ledger_test', ...data },
    getTransactions: async () => ({ rows: [], total: 0 }),
    getTransactionsSummary: async () => ({ totalCredits: 0, totalDebits: 0, count: 0 }),
    getPurchaseByPaymentIntent: async (id: string) =>
      mockRegistry.getPurchaseByPaymentIntent ? mockRegistry.getPurchaseByPaymentIntent(id) : null,
    updatePurchaseStatus: async (...args: any[]) =>
      mockRegistry.updatePurchaseStatus ? mockRegistry.updatePurchaseStatus(...args) : undefined,
  }));

  mock.module('../../billing/repositories/customers', () => ({
    getCustomerByAccountId: async (id: string) => {
      if (mockRegistry.getCustomerByAccountId) return mockRegistry.getCustomerByAccountId(id);
      return { id: 'cus_test_123', accountId: 'acc_test_123', email: 'test@example.com', provider: 'stripe', active: true };
    },
    getCustomerByStripeId: async (id: string) => {
      if (mockRegistry.getCustomerByStripeId) return mockRegistry.getCustomerByStripeId(id);
      return { id: 'cus_test_123', accountId: 'acc_test_123', email: 'test@example.com', provider: 'stripe', active: true };
    },
    upsertCustomer: async (data: any) =>
      mockRegistry.upsertCustomer ? mockRegistry.upsertCustomer(data) : undefined,
  }));

  // NOTE: The credits service mock is NOT registered here.
  // credits.test.ts needs the REAL credits module (with mocked deps).
  // Other billing test files that need to stub grantCredits/resetExpiringCredits
  // should call registerCreditsMock() separately.


  mock.module('../../platform/services/sandbox-provisioner', () => ({
    provisionSandboxFromCheckout: async (...args: any[]) =>
      mockRegistry.provisionSandboxFromCheckout ? mockRegistry.provisionSandboxFromCheckout(...args) : undefined,
    archiveSandboxBySubscription: async () => undefined,
  }));

  // db mock — revertToFree queries active sandboxes; return empty array by default
  mock.module('../../shared/db', () => ({
    hasDatabase: true,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    },
  }));



  mock.module('../../billing/repositories/account-deletion', () => ({
    getActiveDeletionRequest: async (id: string) =>
      mockRegistry.getActiveDeletionRequest ? mockRegistry.getActiveDeletionRequest(id) : null,
    createDeletionRequest: async (...args: any[]) =>
      mockRegistry.createDeletionRequest ? mockRegistry.createDeletionRequest(...args) : null,
    cancelDeletionRequest: async (id: string) =>
      mockRegistry.cancelDeletionRequest ? mockRegistry.cancelDeletionRequest(id) : undefined,
    markDeletionCompleted: async (id: string) =>
      mockRegistry.markDeletionCompleted ? mockRegistry.markDeletionCompleted(id) : undefined,
    getScheduledDeletions: async () =>
      mockRegistry.getScheduledDeletions ? mockRegistry.getScheduledDeletions() : [],
  }));
}

// ─── Credits Service Mock (separate from registerGlobalMocks) ────────────────
// Call this from test files that need grantCredits/resetExpiringCredits to be
// stubbed (webhooks, subscriptions, yearly-rotation). Do NOT call from credits.test.ts.

let _creditsMockRegistered = false;
export function registerCreditsMock() {
  if (_creditsMockRegistered) return;
  _creditsMockRegistered = true;

  mock.module('../../billing/services/credits', () => ({
    calculateTokenCost: () => 0,
    getBalance: async () => ({ balance: 0, expiring: 0, nonExpiring: 0, daily: 0 }),
    getCreditSummary: async () => ({ total: 0, daily: 0, monthly: 0, extra: 0, canRun: true }),
    deductCredits: async () => ({ success: true, cost: 0, newBalance: 0, transactionId: 'tx_mock' }),
    refreshDailyCredits: async () => null,
    grantCredits: async (...args: any[]) =>
      mockRegistry.grantCredits ? mockRegistry.grantCredits(...args) : undefined,
    resetExpiringCredits: async (...args: any[]) =>
      mockRegistry.resetExpiringCredits ? mockRegistry.resetExpiringCredits(...args) : undefined,
  }));
}

export function createMockCreditAccount(overrides: Record<string, any> = {}) {
  return {
    accountId: 'acc_test_123',
    balance: '100.0000',
    expiringCredits: '80.0000',
    nonExpiringCredits: '20.0000',
    dailyCreditsBalance: '3.00',
    lifetimeGranted: '500.0000',
    lifetimePurchased: '100.0000',
    lifetimeUsed: '400.0000',
    tier: 'tier_6_50',
    provider: 'stripe',
    planType: 'monthly',
    stripeSubscriptionId: 'sub_test_123',
    stripeSubscriptionStatus: 'active',
    billingCycleAnchor: '2025-01-01T00:00:00Z',
    nextCreditGrant: '2025-02-01T00:00:00Z',
    lastGrantDate: '2025-01-01T00:00:00Z',
    lastDailyRefresh: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    trialStatus: 'none',
    trialEndsAt: null,
    commitmentType: null,
    commitmentEndDate: null,
    scheduledTierChange: null,
    scheduledTierChangeDate: null,
    scheduledPriceId: null,
    lastProcessedInvoiceId: null,
    lastRenewalPeriodStart: null,
    paymentStatus: 'active',
    lastPaymentFailure: null,
    revenuecatCustomerId: null,
    revenuecatSubscriptionId: null,
    revenuecatCancelledAt: null,
    revenuecatCancelAtPeriodEnd: null,
    revenuecatPendingChangeProduct: null,
    revenuecatPendingChangeDate: null,
    revenuecatPendingChangeType: null,
    revenuecatProductId: null,
    isGrandfatheredFree: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─── Stripe Mock Objects ──────────────────────────────────────────────────────

export function createMockStripeSubscription(overrides: Record<string, any> = {}) {
  return {
    id: 'sub_test_123',
    customer: 'cus_test_123',
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    billing_cycle_anchor: Math.floor(Date.now() / 1000) - 86400 * 30,
    current_period_start: Math.floor(Date.now() / 1000) - 86400 * 30,
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    items: {
      data: [
        {
          id: 'si_test_123',
          price: {
            id: 'price_test_123',
            unit_amount: 5000,
            currency: 'usd',
          },
        },
      ],
    },
    metadata: {
      account_id: 'acc_test_123',
      tier_key: 'tier_6_50',
    },
    ...overrides,
  };
}

export function createMockStripeInvoice(overrides: Record<string, any> = {}) {
  return {
    id: 'in_test_123',
    subscription: 'sub_test_123',
    customer: 'cus_test_123',
    billing_reason: 'subscription_cycle',
    amount_total: 5000,
    amount_paid: 5000,
    currency: 'usd',
    status: 'paid',
    period_start: Math.floor(Date.now() / 1000),
    period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    payment_intent: 'pi_test_123',
    ...overrides,
  };
}

export function createMockStripeCheckoutSession(overrides: Record<string, any> = {}) {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    subscription: 'sub_test_123',
    customer: 'cus_test_123',
    customer_email: 'test@example.com',
    amount_total: 5000,
    payment_intent: null,
    metadata: {
      account_id: 'acc_test_123',
      tier_key: 'tier_6_50',
      commitment_type: 'monthly',
    },
    ...overrides,
  };
}

let _evtCounter = 0;
export function createMockStripeEvent(type: string, object: any, overrides: Record<string, any> = {}) {
  return {
    id: `evt_test_${++_evtCounter}`,
    type,
    data: { object },
    created: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

export function createMockSupabaseRpc(results: Record<string, { data?: any; error?: any }> = {}) {
  return {
    rpc: (name: string, params?: any) => {
      const result = results[name];
      if (result) {
        return Promise.resolve(result);
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

export function createMockStripeClient(overrides: Record<string, any> = {}) {
  const defaultSubscription = createMockStripeSubscription();

  return {
    webhooks: {
      constructEvent: overrides.constructEvent ?? ((body: string, sig: string, secret: string) => {
        return JSON.parse(body);
      }),
    },
    subscriptions: {
      retrieve: overrides.subscriptionsRetrieve ?? (async (id: string) => defaultSubscription),
      update: overrides.subscriptionsUpdate ?? (async (id: string, params: any) => ({
        ...defaultSubscription,
        ...params,
      })),
      create: overrides.subscriptionsCreate ?? (async (params: any) => defaultSubscription),
      cancel: overrides.subscriptionsCancel ?? (async (id: string) => ({})),
    },
    customers: {
      create: overrides.customersCreate ?? (async (params: any) => ({
        id: 'cus_new_123',
        email: params.email,
        metadata: params.metadata,
      })),
      retrieve: overrides.customersRetrieve ?? (async (id: string) => ({
        id,
        invoice_settings: { default_payment_method: null },
        default_source: null,
      })),
    },
    prices: {
      retrieve: overrides.pricesRetrieve ?? (async (id: string) => ({
        id,
        unit_amount: 5000,
        currency: 'usd',
        recurring: { interval: 'month' as const },
      })),
    },
    paymentMethods: {
      list: overrides.paymentMethodsList ?? (async () => ({ data: [] })),
    },
    checkout: {
      sessions: {
        create: overrides.checkoutSessionsCreate ?? (async (params: any) => ({
          id: 'cs_new_123',
          url: 'https://checkout.stripe.com/test',
          ...params,
        })),
        retrieve: overrides.checkoutSessionsRetrieve ?? (async (id: string) => createMockStripeCheckoutSession()),
      },
    },
    billingPortal: {
      sessions: {
        create: overrides.portalSessionsCreate ?? (async (params: any) => ({
          url: 'https://billing.stripe.com/test',
        })),
      },
    },
    promotionCodes: {
      list: overrides.promotionCodesList ?? (async () => ({ data: [] })),
    },
    invoices: {
      retrieveUpcoming: overrides.invoicesRetrieveUpcoming ?? (async () => ({
        amount_due: 2500,
        currency: 'usd',
        subscription_proration_date: Math.floor(Date.now() / 1000),
      })),
    },
    subscriptionSchedules: {
      create: overrides.subscriptionSchedulesCreate ?? (async (params: any) => ({
        id: 'sub_sched_test_123',
        subscription: params.from_subscription ?? 'sub_test_123',
        status: 'active',
        phases: [],
        metadata: {},
      })),
      update: overrides.subscriptionSchedulesUpdate ?? (async (id: string, params: any) => ({
        id,
        status: 'active',
        ...params,
      })),
      retrieve: overrides.subscriptionSchedulesRetrieve ?? (async (id: string) => ({
        id,
        status: 'active',
        phases: [],
        metadata: {},
      })),
      release: overrides.subscriptionSchedulesRelease ?? (async (id: string) => ({
        id,
        status: 'released',
      })),
    },
    ...overrides.extra,
  };
}

export function createMockRevenueCatEvent(type: string, overrides: Record<string, any> = {}) {
  return {
    event: {
      type,
      app_user_id: overrides.app_user_id ?? 'acc_test_123',
      product_id: overrides.product_id ?? 'kortix_pro_monthly',
      subscriber_id: overrides.subscriber_id ?? 'sub_rc_123',
      price: overrides.price ?? 50,
      expiration_at_ms: overrides.expiration_at_ms ?? null,
      effective_date: overrides.effective_date ?? null,
      new_product_id: overrides.new_product_id ?? null,
      ...overrides,
    },
  };
}
