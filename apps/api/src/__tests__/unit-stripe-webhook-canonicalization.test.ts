import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  getCreditAccountResult: null as any,
  getCustomerByStripeIdResult: null as any,
  upsertCreditAccountCalls: [] as Array<{ accountId: string; data: Record<string, unknown> }>,
  updateCreditAccountCalls: [] as Array<{ accountId: string; data: Record<string, unknown> }>,
  resetExpiringCreditsCalls: [] as Array<any[]>,
  stripeUpdateCalls: [] as Array<{ id: string; params: Record<string, unknown> }>,
};

const mockStripeClient = {
  webhooks: {
    constructEvent: (_body: string, _sig: string, _secret: string) => ({ id: 'evt_test', type: 'customer.subscription.updated', data: { object: {} } }),
  },
  subscriptions: {
    retrieve: async () => ({}),
    update: async (id: string, params: Record<string, unknown>) => {
      state.stripeUpdateCalls.push({ id, params });
      return { id, ...params };
    },
  },
};

mock.module('../shared/stripe', () => ({
  getStripe: () => mockStripeClient,
}));

mock.module('../config', () => ({
  config: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    REVENUECAT_WEBHOOK_SECRET: 'rc_test',
    INTERNAL_KORTIX_ENV: 'prod',
  },
}));

mock.module('@kortix/shared', () => ({
  AUTO_TOPUP_DEFAULT_AMOUNT: 20,
  AUTO_TOPUP_DEFAULT_THRESHOLD: 5,
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => state.getCreditAccountResult,
  upsertCreditAccount: async (accountId: string, data: Record<string, unknown>) => {
    state.upsertCreditAccountCalls.push({ accountId, data });
  },
  updateCreditAccount: async (accountId: string, data: Record<string, unknown>) => {
    state.updateCreditAccountCalls.push({ accountId, data });
  },
}));

mock.module('../billing/repositories/customers', () => ({
  getCustomerByStripeId: async () => state.getCustomerByStripeIdResult,
  upsertCustomer: async () => null,
}));

mock.module('../billing/repositories/transactions', () => ({
  updatePurchaseStatus: async () => null,
  getPurchaseByPaymentIntent: async () => null,
}));

mock.module('../billing/services/credits', () => ({
  grantCredits: async () => null,
  resetExpiringCredits: async (...args: any[]) => {
    state.resetExpiringCreditsCalls.push(args);
  },
}));

mock.module('../billing/services/machine-bonus', () => ({
  grantMachineBonusOnce: async () => null,
  getStripeMachineBonusKey: (subscriptionId: string) => `machine_bonus:${subscriptionId}`,
}));

mock.module('../billing/services/subscriptions', () => ({
  cancelFreeSubscriptionForUpgrade: async () => null,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async (id: string) => id,
}));

const { processStripeWebhook } = await import('../billing/services/webhooks');

beforeEach(() => {
  state.getCreditAccountResult = null;
  state.getCustomerByStripeIdResult = null;
  state.upsertCreditAccountCalls = [];
  state.updateCreditAccountCalls = [];
  state.resetExpiringCreditsCalls = [];
  state.stripeUpdateCalls = [];
});

describe('Stripe webhook canonicalization', () => {
  test('repairs legacy account_id metadata and restores canonical billing state', async () => {
    const subscription = {
      id: 'sub_legacy_123',
      customer: 'cus_legacy_123',
      status: 'active',
      cancel_at_period_end: false,
      billing_cycle_anchor: 1771849066,
      current_period_end: 1803385066,
      items: {
        data: [
          {
            id: 'si_legacy_123',
            price: {
              id: 'price_1ReHB5G6l1KZGqIrD70I1xqM',
              unit_amount: 20400,
              currency: 'usd',
            },
          },
        ],
      },
      metadata: {
        account_id: 'legacy_user_123',
        commitment_type: 'yearly',
      },
    };

    mockStripeClient.webhooks.constructEvent = () => ({
      id: 'evt_test_canonical',
      type: 'customer.subscription.updated',
      data: { object: subscription },
    });

    state.getCustomerByStripeIdResult = {
      id: 'cus_legacy_123',
      accountId: 'acc_canonical_123',
      email: 'legacy@example.com',
      provider: 'stripe',
      active: true,
    };

    await processStripeWebhook(JSON.stringify({}), 'sig');

    expect(state.upsertCreditAccountCalls).toHaveLength(1);
    expect(state.upsertCreditAccountCalls[0].accountId).toBe('acc_canonical_123');
    expect(state.upsertCreditAccountCalls[0].data.tier).toBe('tier_2_20');
    expect(state.resetExpiringCreditsCalls).toContainEqual([
      'acc_canonical_123',
      20,
      'Recovered Stripe subscription: 20 credits',
      'legacy_sync:sub_legacy_123',
    ]);
    expect(state.stripeUpdateCalls).toHaveLength(1);
    expect(state.stripeUpdateCalls[0]).toEqual({
      id: 'sub_legacy_123',
      params: {
        metadata: {
          account_id: 'acc_canonical_123',
          commitment_type: 'yearly',
          legacy_account_id: 'legacy_user_123',
        },
      },
    });
  });
});
