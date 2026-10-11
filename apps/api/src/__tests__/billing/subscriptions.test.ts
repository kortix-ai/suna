import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { BillingError } from '../../errors';
import {
  createMockCreditAccount,
  createMockStripeSubscription,
  createMockStripeCheckoutSession,
  createMockStripeClient,
  mockRegistry,
  registerGlobalMocks,
  registerWalletMock,
  fakeWallet,
  resetMockRegistry,
} from './mocks';

// Register global mocks + the fake wallet (records every grant and reset)
registerGlobalMocks();
registerWalletMock();

// Per-seat checkout reads the active member count for the Stripe quantity.
// Stub it so the unit test doesn't reach for the DB.
mock.module('../../billing/services/seat-management', () => ({
  countActiveMembers: async () => 1,
}));

// ─── Track calls ──────────────────────────────────────────────────────────────

let upsertCreditAccountCalls: any[] = [];
let updateCreditAccountCalls: any[] = [];
let upsertCustomerCalls: any[] = [];
const walletGrants = fakeWallet.calls.grant;
let stripeCancelSubCalls: any[] = [];

beforeEach(() => {
  upsertCreditAccountCalls = [];
  updateCreditAccountCalls = [];
  upsertCustomerCalls = [];
  stripeCancelSubCalls = [];
  resetMockRegistry();

  // Stripe client
  mockRegistry.stripeClient = createMockStripeClient();
  mockRegistry.stripeClient.subscriptions.cancel = async (id: string) => {
    stripeCancelSubCalls.push(id);
    return {};
  };

  // Credit account repo defaults
  mockRegistry.getCreditAccount = async () => createMockCreditAccount();
  mockRegistry.getCreditBalance = async () => {
    const a = createMockCreditAccount();
    return { balance: a.balance, expiringCredits: a.expiringCredits, nonExpiringCredits: a.nonExpiringCredits, dailyCreditsBalance: a.dailyCreditsBalance, tier: a.tier };
  };
  mockRegistry.updateCreditAccount = async (id: string, data: any) => {
    updateCreditAccountCalls.push({ accountId: id, data });
  };
  mockRegistry.upsertCreditAccount = async (id: string, data: any) => {
    upsertCreditAccountCalls.push({ accountId: id, data });
  };

  // Customer repo defaults
  mockRegistry.getCustomerByAccountId = async () => ({
    id: 'cus_test_123',
    accountId: 'acc_test_123',
    email: 'test@example.com',
    provider: 'stripe',
    active: true,
  });
  mockRegistry.getCustomerByStripeId = async () => ({
    id: 'cus_test_123',
    accountId: 'acc_test_123',
    email: 'test@example.com',
    provider: 'stripe',
    active: true,
  });
  mockRegistry.upsertCustomer = async (data: any) => {
    upsertCustomerCalls.push(data);
  };

  // Credit service defaults
});

// Import AFTER mocking
const {
  getOrCreateStripeCustomer,
  createPerSeatCheckoutSession,
  createInlineCheckout,
  confirmInlineCheckout,
  cancelSubscription,
  reactivateSubscription,
  cancelScheduledChange,
  cancelFreeSubscriptionForUpgrade,
} = await import('../../billing/services/subscriptions');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getOrCreateStripeCustomer', () => {
  test('returns existing customer ID', async () => {
    const customerId = await getOrCreateStripeCustomer('acc_test_123', 'test@example.com');
    expect(customerId).toBe('cus_test_123');
  });

  test('creates new customer when not found', async () => {
    mockRegistry.getCustomerByAccountId = async () => null;

    const customerId = await getOrCreateStripeCustomer('acc_test_123', 'new@example.com');
    expect(customerId).toBe('cus_new_123');
    expect(upsertCustomerCalls.length).toBe(1);
    expect(upsertCustomerCalls[0].email).toBe('new@example.com');
  });
});

describe('createPerSeatCheckoutSession', () => {
  test('always opens hosted Checkout — never instant-creates the subscription', async () => {
    // Account already has a card/subscription on file — the old code path would
    // have short-circuited to a direct subscriptions.create here.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat' });

    let directSubCreateCalled = false;
    mockRegistry.stripeClient.subscriptions.create = async () => {
      directSubCreateCalled = true;
      return createMockStripeSubscription();
    };
    let checkoutParams: any = null;
    mockRegistry.stripeClient.checkout.sessions.create = async (params: any) => {
      checkoutParams = params;
      return { id: 'cs_perseat_123', url: 'https://checkout.stripe.com/perseat' };
    };

    const result = await createPerSeatCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      successUrl: 'https://example.com/projects?team_signup=success',
      cancelUrl: 'https://example.com/cancel',
    });

    // The actual Stripe checkout starts — no phantom "subscription_created".
    expect((result as any).status).toBe('checkout_created');
    expect((result as any).checkout_url).toBe('https://checkout.stripe.com/perseat');
    expect(directSubCreateCalled).toBe(false);
    // Subscription-mode checkout with the per-seat quantity = member count.
    expect(checkoutParams.mode).toBe('subscription');
    expect(checkoutParams.line_items[0].quantity).toBe(1);
    expect(checkoutParams.payment_method_collection).toBe('always');
  });
});

describe('cancelSubscription', () => {
  test('sets cancel_at_period_end', async () => {
    let updateParams: any = null;
    mockRegistry.stripeClient.subscriptions.update = async (id: string, params: any) => {
      updateParams = params;
      return createMockStripeSubscription({ ...params, cancel_at: Date.now() / 1000 + 86400 * 30 });
    };

    const result = await cancelSubscription('acc_test_123');
    expect(result.success).toBe(true);
    expect(updateParams.cancel_at_period_end).toBe(true);
  });

  test('throws during commitment period', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        commitmentType: 'yearly_commitment',
        commitmentEndDate: new Date(Date.now() + 86400000 * 365).toISOString(), // 1 year from now
      });

    try {
      await cancelSubscription('acc_test_123');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe('SubscriptionError');
      expect(err.message).toContain('commitment');
    }
  });

  test('mirrors the pending cancellation into paymentStatus for the account state, without waiting on the webhook', async () => {
    mockRegistry.stripeClient.subscriptions.update = async (id: string, params: any) =>
      createMockStripeSubscription({ ...params, cancel_at: Date.now() / 1000 + 86400 * 30 });

    await cancelSubscription('acc_test_123');

    const mirror = updateCreditAccountCalls.find((call) => 'paymentStatus' in call.data);
    expect(mirror?.data.paymentStatus).toBe('cancelling');
  });

  test('allows cancel after commitment expires', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        commitmentType: 'yearly_commitment',
        commitmentEndDate: new Date(Date.now() - 86400000).toISOString(), // Yesterday
      });

    mockRegistry.stripeClient.subscriptions.update = async (id: string, params: any) =>
      createMockStripeSubscription({ cancel_at: Date.now() / 1000 + 86400 * 30 });

    const result = await cancelSubscription('acc_test_123');
    expect(result.success).toBe(true);
  });
});

describe('reactivateSubscription', () => {
  test('clears cancel_at_period_end', async () => {
    let updateParams: any = null;
    mockRegistry.stripeClient.subscriptions.update = async (id: string, params: any) => {
      updateParams = params;
      return createMockStripeSubscription(params);
    };

    const result = await reactivateSubscription('acc_test_123');
    expect(result.success).toBe(true);
    expect(updateParams.cancel_at_period_end).toBe(false);
  });

  test('mirrors the reactivation into paymentStatus for the account state', async () => {
    await reactivateSubscription('acc_test_123');

    const mirror = updateCreditAccountCalls.find((call) => 'paymentStatus' in call.data);
    expect(mirror?.data.paymentStatus).toBe('active');
  });
});

describe('cancelScheduledChange', () => {
  test('clears all scheduled fields', async () => {
    const result = await cancelScheduledChange('acc_test_123');

    expect(result.success).toBe(true);
    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.scheduledTierChange).toBeNull();
    expect(updateCreditAccountCalls[0].data.scheduledTierChangeDate).toBeNull();
    expect(updateCreditAccountCalls[0].data.scheduledPriceId).toBeNull();
  });
});

describe('createInlineCheckout: free tier handling', () => {
  test('does not call handleUpgrade when current tier is free (creates new sub instead)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_old_free',
      });

    let createParams: any = null;
    mockRegistry.stripeClient.subscriptions.create = async (params: any) => {
      createParams = params;
      return createMockStripeSubscription({
        id: 'sub_new_paid',
        latest_invoice: { amount_due: 5000, payment_intent: { client_secret: 'cs_test' } },
        metadata: params.metadata,
      });
    };

    const result = await createInlineCheckout({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'pro',
      billingPeriod: 'monthly',
    });

    expect(createParams?.metadata.previous_subscription_id).toBe('sub_old_free');
    expect((result as any).previous_subscription_id).toBe('sub_old_free');
  });

  test('cancels old free sub immediately when amount_due is 0', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_old_free',
      });

    mockRegistry.stripeClient.subscriptions.create = async (params: any) =>
      createMockStripeSubscription({
        id: 'sub_new_paid',
        latest_invoice: { amount_due: 0, payment_intent: null },
        metadata: params.metadata,
      });

    const result = await createInlineCheckout({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'pro',
      billingPeriod: 'monthly',
    });

    expect((result as any).no_payment_required).toBe(true);
    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(stripeCancelSubCalls).toEqual(['sub_old_free']);
  });
});

// The staging `pro` monthly price (tests run with INTERNAL_KORTIX_ENV=staging).
const STAGING_PRO_PRICE = 'price_1TeyA7G6l1KZGqIr7ZhEpoVm';

function paidProSubscription(overrides: Record<string, any> = {}) {
  return createMockStripeSubscription({
    id: 'sub_new_paid',
    status: 'active',
    customer: 'cus_test_123',
    items: { data: [{ id: 'si_pro', price: { id: STAGING_PRO_PRICE, unit_amount: 2000, currency: 'usd' } }] },
    metadata: {
      account_id: 'acc_test_123',
      tier_key: 'pro',
      billing_period: 'monthly',
    },
    ...overrides,
  });
}

describe('confirmInlineCheckout: cancel old free sub', () => {
  test('cancels old free sub when previous_subscription_id in subscription metadata', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      paidProSubscription({
        metadata: {
          account_id: 'acc_test_123',
          tier_key: 'pro',
          billing_period: 'monthly',
          previous_subscription_id: 'sub_old_free',
        },
      });

    let cancelledSubId: string | null = null;
    mockRegistry.stripeClient.subscriptions.cancel = async (id: string) => {
      cancelledSubId = id;
      return {};
    };

    const result = await confirmInlineCheckout({
      accountId: 'acc_test_123',
      subscriptionId: 'sub_new_paid',
    });

    expect(result.success).toBe(true);
    //@ts-ignore
    expect(cancelledSubId).toBe('sub_old_free');
  });

  test('does not cancel when no previous_subscription_id in metadata', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () => paidProSubscription();

    let cancelCalled = false;
    mockRegistry.stripeClient.subscriptions.cancel = async () => {
      cancelCalled = true;
      return {};
    };

    const result = await confirmInlineCheckout({
      accountId: 'acc_test_123',
      subscriptionId: 'sub_new_paid',
    });

    expect(result.success).toBe(true);
    expect(cancelCalled).toBe(false);
  });
});

describe('confirmInlineCheckout: the subscription must be the caller\'s and the tier comes from its price', () => {
  function tierWrites() {
    return [...upsertCreditAccountCalls, ...updateCreditAccountCalls].filter((c: any) => 'tier' in c.data);
  }

  test('a subscription billed to another account\'s Stripe customer is rejected with 404 and writes nothing', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      paidProSubscription({ customer: 'cus_other_account' });
    mockRegistry.getCustomerByStripeId = async (id: string) => ({
      id,
      accountId: 'acc_someone_else',
      email: null,
      provider: 'stripe',
      active: true,
    });

    await expect(
      confirmInlineCheckout({ accountId: 'acc_test_123', subscriptionId: 'sub_new_paid' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(tierWrites()).toHaveLength(0);
  });

  test('a subscription whose customer is unmapped is rejected with 404', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () => paidProSubscription({ customer: 'cus_unknown' });
    mockRegistry.getCustomerByStripeId = async () => null;

    await expect(
      confirmInlineCheckout({ accountId: 'acc_test_123', subscriptionId: 'sub_new_paid' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(tierWrites()).toHaveLength(0);
  });

  test('the tier written is the one the price pays for, whatever the metadata or body names', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      paidProSubscription({
        metadata: { account_id: 'acc_test_123', tier_key: 'enterprise', plan_key: 'enterprise', billing_period: 'monthly' },
      });

    const result = await confirmInlineCheckout({
      accountId: 'acc_test_123',
      subscriptionId: 'sub_new_paid',
      // A client-supplied tier is not part of the contract and has no effect.
      ...({ tierKey: 'enterprise' } as Record<string, unknown>),
    } as any);

    expect(result.tier).toBe('pro');
    const writes = tierWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].data.tier).toBe('pro');
  });

  test('a subscription on a price that maps to no plan is rejected with 400', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      paidProSubscription({
        items: { data: [{ id: 'si_x', price: { id: 'price_not_a_plan', unit_amount: 100, currency: 'usd' } }] },
      });

    await expect(
      confirmInlineCheckout({ accountId: 'acc_test_123', subscriptionId: 'sub_new_paid' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(tierWrites()).toHaveLength(0);
  });

  test('an incomplete subscription is not activated', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () => paidProSubscription({ status: 'incomplete' });

    await expect(
      confirmInlineCheckout({ accountId: 'acc_test_123', subscriptionId: 'sub_new_paid' }),
    ).rejects.toThrow('Subscription is not active');
    expect(tierWrites()).toHaveLength(0);
  });

  test.each([undefined, 'cs_not_a_subscription'])(
    'a missing or malformed subscription_id (%p) is rejected with 400',
    async (subscriptionId) => {
      // Stripe would answer with a paid, owned subscription: only the id check
      // can refuse it.
      mockRegistry.stripeClient.subscriptions.retrieve = async () =>
        paidProSubscription({ id: subscriptionId });

      await expect(
        confirmInlineCheckout({ accountId: 'acc_test_123', subscriptionId }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(tierWrites()).toHaveLength(0);
    },
  );
});

describe('cancelFreeSubscriptionForUpgrade', () => {
  test('calls stripe.subscriptions.cancel', async () => {
    let cancelledId: string | null = null;
    mockRegistry.stripeClient.subscriptions.cancel = async (id: string) => {
      cancelledId = id;
      return {};
    };

    await cancelFreeSubscriptionForUpgrade('sub_old_free', 'acc_test_123');
    //@ts-ignore
    expect(cancelledId).toBe('sub_old_free');
  });

  test('does not throw when cancel fails with 404 (resource_missing)', async () => {
    mockRegistry.stripeClient.subscriptions.cancel = async () => {
      const err: any = new Error('No such subscription');
      err.code = 'resource_missing';
      err.statusCode = 404;
      throw err;
    };

    // Should not throw — 404/resource_missing is silently ignored
    await cancelFreeSubscriptionForUpgrade('sub_old_free', 'acc_test_123');
  });

  test('re-throws non-404 cancel errors', async () => {
    mockRegistry.stripeClient.subscriptions.cancel = async () => {
      throw new Error('Stripe internal error');
    };

    await expect(
      cancelFreeSubscriptionForUpgrade('sub_old_free', 'acc_test_123')
    ).rejects.toThrow('Stripe internal error');
  });
});

// ─── Checkout session retrieval: a session Stripe does not know is a 404 ────
// The checkout-session route takes the session id from the client (the GET
// path parameter). An id Stripe has never seen — arbitrary
// input, a stale id, or one minted by a different Stripe account after the
// key was repointed — makes `stripe.checkout.sessions.retrieve` throw
// `StripeInvalidRequestError: No such checkout.session: <id>`. That throw
// fell through the typed-error ladder in apps/api/src/http-errors.ts to the
// generic 500 + Sentry path (Better Stack pattern ca919c3d…, application
// 2346961). A missing session is an expected state: the GET route already
// declares 404.

describe('checkout session retrieval: missing session maps to a typed 404', () => {
  const throwNoSuchCheckoutSession = () => {
    const err: any = new Error('No such checkout.session: cs_missing_123');
    err.type = 'StripeInvalidRequestError';
    err.code = 'resource_missing';
    err.statusCode = 404;
    throw err;
  };

  test('getCheckoutSessionDetails throws BillingError 404, without echoing the id', async () => {
    mockRegistry.stripeClient.checkout.sessions.retrieve = throwNoSuchCheckoutSession;

    const { getCheckoutSessionDetails } = await import('../../billing/services/subscriptions');
    const err: unknown = await getCheckoutSessionDetails('acc_test_123', 'cs_missing_123').then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).statusCode).toBe(404);
    expect((err as BillingError).message).not.toContain('cs_missing_123');
  });

  test('a non-missing (transient) Stripe failure still rethrows raw', async () => {
    mockRegistry.stripeClient.checkout.sessions.retrieve = async () => {
      throw new Error('Stripe internal error');
    };

    const { getCheckoutSessionDetails } = await import('../../billing/services/subscriptions');
    await expect(
      getCheckoutSessionDetails('acc_test_123', 'cs_missing_123'),
    ).rejects.toThrow('Stripe internal error');
  });
});
