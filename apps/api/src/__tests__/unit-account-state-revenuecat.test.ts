import { beforeEach, describe, expect, mock, test } from 'bun:test';

let subscriptionInfo: any = null;
let creditSummary: any = null;
let autoTopup: any = null;
let isAdmin = false;

mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => null,
  getCreditBalance: async () => null,
  updateCreditAccount: async () => undefined,
  upsertCreditAccount: async () => undefined,
  getSubscriptionInfo: async () => subscriptionInfo,
  updateBalance: async () => undefined,
  getYearlyAccountsDueForRotation: async () => [],
}));

mock.module('../billing/services/credits', () => ({
  getCreditSummary: async () => creditSummary,
  calculateTokenCost: () => 0,
  getBalance: async () => ({ balance: 0, expiring: 0, nonExpiring: 0, daily: 0 }),
  deductCredits: async () => ({ success: true, cost: 0, newBalance: 0, transactionId: 'tx_mock' }),
  refreshDailyCredits: async () => null,
  grantCredits: async () => undefined,
  resetExpiringCredits: async () => undefined,
}));

mock.module('../billing/services/auto-topup', () => ({
  getAutoTopupSettings: async () => autoTopup,
}));

mock.module('../shared/platform-roles', () => ({
  isPlatformAdmin: async () => isAdmin,
}));

const { buildMinimalAccountState } = await import('../billing/services/account-state');

describe('buildMinimalAccountState revenuecat', () => {
  beforeEach(() => {
    subscriptionInfo = {
      tier: 'tier_2_20',
      provider: 'revenuecat',
      planType: 'monthly',
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialStatus: 'none',
      trialEndsAt: null,
      commitmentType: null,
      commitmentEndDate: null,
      scheduledTierChange: null,
      scheduledTierChangeDate: null,
      scheduledPriceId: null,
      billingCycleAnchor: null,
      nextCreditGrant: null,
      lastDailyRefresh: null,
      paymentStatus: 'active',
      revenuecatProductId: 'kortix_plus_monthly',
      revenuecatCustomerId: 'rc_customer_123',
      revenuecatSubscriptionId: 'rc_sub_123',
      revenuecatPendingChangeProduct: null,
      revenuecatPendingChangeDate: null,
      revenuecatPendingChangeType: null,
      revenuecatCancelledAt: null,
      revenuecatCancelAtPeriodEnd: null,
    };

    creditSummary = { total: 25, daily: 0, monthly: 20, extra: 5, canRun: true };
    autoTopup = { enabled: true, threshold: 1, amount: 5 };
    isAdmin = false;
  });

  test('reports active revenuecat subscription from kortix row', async () => {
    const state = await buildMinimalAccountState('acc_test_123');

    expect(state.subscription.provider).toBe('revenuecat');
    expect(state.subscription.status).toBe('active');
    expect(state.subscription.subscription_id).toBe('rc_sub_123');
    expect(state.tier.name).toBe('tier_2_20');
    expect(state.can_claim_computer).toBe(true);
  });

  test('reports past_due revenuecat subscription correctly', async () => {
    subscriptionInfo.paymentStatus = 'past_due';

    const state = await buildMinimalAccountState('acc_test_123');

    expect(state.subscription.status).toBe('past_due');
  });

  test('reports canceled revenuecat subscription correctly', async () => {
    subscriptionInfo.revenuecatCancelledAt = new Date().toISOString();

    const state = await buildMinimalAccountState('acc_test_123');

    expect(state.subscription.status).toBe('canceled');
    expect(state.subscription.is_cancelled).toBe(true);
  });
});
