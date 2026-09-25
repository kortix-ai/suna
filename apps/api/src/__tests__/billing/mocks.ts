/**
 * Shared mock factories for billing unit tests.
 *
 * Uses a global mock registry so multiple test files can share
 * the same mock.module() registrations without conflicts.
 */
import { mock } from 'bun:test';
import * as realProviders from '../../platform/providers';
import * as realSandboxReaper from '../../projects/sandbox-reaper';
import { createFakeWallet } from '../../billing/wallet/fake';

// ─── Global Mock Registry ─────────────────────────────────────────────────────

/**
 * The wallet every billing unit test shares once `registerWalletMock()` ran.
 * Read `fakeWallet.calls.grant` / `.reset` / …; `resetMockRegistry()` restores it.
 */
export const fakeWallet = createFakeWallet();

export const mockRegistry = {
  stripeClient: null as any,

  getCreditAccount: null as ((id: string) => Promise<any>) | null,
  getCreditBalance: null as ((id: string) => Promise<any>) | null,
  updateCreditAccount: null as ((id: string, data: any) => Promise<void>) | null,
  upsertCreditAccount: null as ((id: string, data: any) => Promise<void>) | null,
  getYearlyAccountsDueForRotation: null as (() => Promise<any[]>) | null,
  getFreeAccountsDueForRotation: null as (() => Promise<any[]>) | null,

  getPurchaseByPaymentIntent: null as ((id: string) => Promise<any>) | null,
  updatePurchaseStatus: null as ((...args: any[]) => Promise<void>) | null,

  getCustomerByAccountId: null as ((id: string) => Promise<any>) | null,
  getCustomerByStripeId: null as ((id: string) => Promise<any>) | null,
  upsertCustomer: null as ((data: any) => Promise<void>) | null,
  listAccountStripeCustomerIds: null as ((id: string) => Promise<string[]>) | null,
  deleteCustomerByStripeId: null as ((id: string) => Promise<void>) | null,
  recordWebhookEvent: null as ((eventId: string, eventType: string) => Promise<boolean>) | null,
  isWebhookEventProcessed: null as ((eventId: string) => Promise<boolean>) | null,

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
  fakeWallet.restore();
}

// ─── Register Global Mocks (once per process) ────────────────────────────────

let _registered = false;
export function registerGlobalMocks() {
  if (_registered) return;
  _registered = true;

  mock.module('../../shared/stripe', () => ({
    getStripe: () => mockRegistry.stripeClient ?? createMockStripeClient(),
  }));

  mock.module('../../config', () => ({
    config: {
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      KORTIX_BILLING_INTERNAL_ENABLED: true,
      INTERNAL_KORTIX_ENV: 'staging',
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
    getFreeAccountsDueForRotation: async () =>
      mockRegistry.getFreeAccountsDueForRotation ? mockRegistry.getFreeAccountsDueForRotation() : [],
  }));

  mock.module('../../billing/repositories/transactions', () => ({
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
    listAccountStripeCustomerIds: async (id: string) =>
      mockRegistry.listAccountStripeCustomerIds ? mockRegistry.listAccountStripeCustomerIds(id) : [],
    deleteCustomerByStripeId: async (id: string) =>
      mockRegistry.deleteCustomerByStripeId ? mockRegistry.deleteCustomerByStripeId(id) : undefined,
  }));

  // Webhook dedup + per-account advisory lock use the raw db (no DATABASE_URL in
  // tests). Default: every event is new; the lock is a pass-through.
  mock.module('../../billing/services/webhook-concurrency', () => ({
    // Forward the real arguments: the dedupe key is what the RevenueCat/Stripe
    // paths actually vary, so a stub that swallows it makes duplicate-event
    // tests pass on a constant `undefined` key instead of the real one.
    recordWebhookEvent: async (eventId: string, eventType: string) =>
      mockRegistry.recordWebhookEvent ? mockRegistry.recordWebhookEvent(eventId, eventType) : true,
    isWebhookEventProcessed: async (eventId: string) =>
      mockRegistry.isWebhookEventProcessed ? mockRegistry.isWebhookEventProcessed(eventId) : false,
    withAccountLock: async (_accountId: string, fn: () => Promise<any>) => fn(),
  }));

  // NOTE: The wallet mock is NOT registered here. Test files whose code under
  // test moves credit call registerWalletMock() and read `fakeWallet.calls`.


  mock.module('../../platform/services/sandbox-provisioner', () => ({
    provisionSandboxFromCheckout: async (...args: any[]) =>
      mockRegistry.provisionSandboxFromCheckout ? mockRegistry.provisionSandboxFromCheckout(...args) : undefined,
  }));

  // account-deletion.ts's stopAccountSandboxes reads active sandboxes and stops
  // them via the provider before tearing down the account. None of the
  // deletion-flow tests in this directory exercise sandbox-stopping, so the
  // default here is simply "no active sandboxes" — a harmless no-op for every
  // existing test, and enough for stopAccountSandboxes' static imports to
  // resolve without needing a real DB/provider.
  // A module mock REPLACES the whole module, so every export the code under
  // test imports has to appear here — a missing one is not a silent undefined,
  // it is a hard `SyntaxError: Export named 'x' not found` that kills the file.
  mock.module('../../shared/db', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    },
    // Real shape is a boolean const, not a function. FALSE on purpose: these
    // billing tests drive the no-DB path, and the stub `db` above answers only
    // `select().from().where()`. Flipping this to true sends the code down real
    // persistence branches this mock cannot serve (8 createCheckoutSession
    // tests fail with "Stripe API error" — verified).
    hasDatabase: false,
  }));

  // Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
  // lists exports by hand deletes every export it omits — the failure surfaces in
  // whatever unrelated file imports the missing name next, attributed to no test.
  mock.module('../../platform/providers', () => ({
    ...realProviders,
    getProvider: (_name: string) => ({
      stop: async (_externalId: string) => undefined,
    }),
    // Real contract: no args, always a number >= 60.
    providerAutoStopBackstopMinutes: () => 60,
  }));

  // Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
  // lists exports by hand deletes every export it omits — the failure surfaces in
  // whatever unrelated file imports the missing name next, attributed to no test.
  mock.module('../../projects/sandbox-reaper', () => ({
    ...realSandboxReaper,
    isAlreadyNotRunning: (_err: unknown) => false,
    reconcileSandboxStoppedByExternalId: async (_externalId: string) => true,
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

// ─── Wallet Mock (separate from registerGlobalMocks) ─────────────────────────
// Call this from test files whose code under test moves credit (webhooks,
// subscriptions, rotations, deletion). Assert on `fakeWallet.calls`.

let _walletMockRegistered = false;
export function registerWalletMock() {
  if (_walletMockRegistered) return;
  _walletMockRegistered = true;

  mock.module('../../billing/wallet', () => ({ wallet: fakeWallet.wallet }));
  mock.module('../../billing/services/credits', () => ({
    calculateTokenCost: () => 0,
    getCreditSummary: () => ({ total: 0, daily: 0, monthly: 0, extra: 0 }),
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
    // Enterprise entitlement overrides — default off so existing per-seat/legacy
    // tests are unaffected; per-seat webhook tests can override to assert the
    // no-clobber guard for enterprise-entitled accounts.
    enterpriseEntitled: false,
    demoEnterprise: false,
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
    // Real Stripe always sets these two on a completed session. `payment_status`
    // is the fraud gate in handleSubscriptionCheckout: only 'paid' activates.
    // Defaulting it to 'paid' keeps this factory a HAPPY-PATH factory; tests for
    // the unpaid path override it explicitly.
    status: 'complete',
    payment_status: 'paid',
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

let stripeEventSequence = 0;

export function createMockStripeEvent(type: string, object: any, overrides: Record<string, any> = {}) {
  stripeEventSequence += 1;
  return {
    id: `evt_test_${Date.now()}_${stripeEventSequence}`,
    type,
    data: { object },
    created: Math.floor(Date.now() / 1000),
    ...overrides,
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
      list: overrides.subscriptionsList ?? (async (params?: any) => ({ data: [] })),
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
        deleted: false,
      })),
    },
    paymentMethods: {
      list: overrides.paymentMethodsList ?? (async () => ({ data: [] })),
    },
    prices: {
      retrieve: overrides.pricesRetrieve ?? (async (id: string) => ({
        id,
        unit_amount: id === 'price_1RIGvuG6l1KZGqIrw14abxeL' ? 0 : 2000,
        recurring: { interval: 'month' },
      })),
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

/**
 * An in-memory dedupe table wired into the registry with the production
 * contract: `isWebhookEventProcessed` reads it, `recordWebhookEvent` writes it.
 * `order` records every marker read/write so tests can assert the marker is
 * written only after the handler ran.
 */
export function installWebhookMarkerTable() {
  const processed = new Set<string>();
  const order: string[] = [];
  mockRegistry.isWebhookEventProcessed = async (eventId: string) => {
    order.push(`check:${eventId}`);
    return processed.has(eventId);
  };
  mockRegistry.recordWebhookEvent = async (eventId: string) => {
    order.push(`record:${eventId}`);
    if (processed.has(eventId)) return false;
    processed.add(eventId);
    return true;
  };
  return { processed, order };
}

export function createMockRevenueCatEvent(type: string, overrides: Record<string, any> = {}) {
  return {
    event: {
      id: overrides.id ?? `evt_rc_${type.toLowerCase()}`,
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
