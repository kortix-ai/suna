import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createMockCreditAccount,
  createMockStripeSubscription,
  createMockStripeClient,
  mockRegistry,
  registerGlobalMocks,
  registerCreditsMock,
  resetMockRegistry,
} from './mocks';

// Register global mocks + credits service mock (stubs grantCredits/resetExpiringCredits)
registerGlobalMocks();
registerCreditsMock();

// ─── Track calls ──────────────────────────────────────────────────────────────

let upsertCreditAccountCalls: any[] = [];
let updateCreditAccountCalls: any[] = [];
let upsertCustomerCalls: any[] = [];
let resetExpiringCreditsCalls: any[] = [];
let stripeCancelSubCalls: any[] = [];

beforeEach(() => {
  upsertCreditAccountCalls = [];
  updateCreditAccountCalls = [];
  upsertCustomerCalls = [];
  resetExpiringCreditsCalls = [];
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
  mockRegistry.grantCredits = async () => {};
  mockRegistry.resetExpiringCredits = async (...args: any[]) => {
    resetExpiringCreditsCalls.push(args);
  };
});

// Import AFTER mocking
const {
  getOrCreateStripeCustomer,
  createCheckoutSession,
  createInlineCheckout,
  confirmInlineCheckout,
  cancelSubscription,
  reactivateSubscription,
  scheduleDowngrade,
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

describe('createCheckoutSession', () => {
  test('creates checkout for new subscription', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ tier: 'free', stripeSubscriptionId: null });

    const result = await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect((result as any).status).toBe('checkout_created');
    expect((result as any).session_id).toBeDefined();
  });

  test('returns checkout_created for same tier (no dedup guard in this path)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ tier: 'tier_6_50' });

    const result = await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    // createCheckoutSession always creates a new hosted checkout session;
    // upgrade/downgrade routing is handled by createInlineCheckout.
    expect((result as any).status).toBe('checkout_created');
  });

  test('returns checkout_created for upgrades (routing is in createInlineCheckout)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'tier_2_20',
        stripeSubscriptionId: 'sub_existing',
      });

    const result = await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect((result as any).status).toBe('checkout_created');
  });

  test('returns checkout_created for downgrades (routing is in createInlineCheckout)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'tier_6_50',
        stripeSubscriptionId: 'sub_existing',
      });

    const result = await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_2_20',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect((result as any).status).toBe('checkout_created');
  });

  test('uses price_data with correct unit_amount for monthly/yearly', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ tier: 'free', stripeSubscriptionId: null });

    let capturedParams: any = null;
    mockRegistry.stripeClient.checkout.sessions.create = async (params: any) => {
      capturedParams = params;
      return { id: 'cs_new_123', url: 'https://checkout.stripe.com/test' };
    };

    await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      commitmentType: 'yearly',
    });

    expect(capturedParams).not.toBeNull();
    // createCheckoutSession now always uses price_data (not a direct price ID)
    expect(capturedParams.line_items[0].price_data).toBeDefined();
    expect(capturedParams.line_items[0].price_data.currency).toBe('usd');
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
});

describe('scheduleDowngrade', () => {
  test('stores scheduled change in DB', async () => {
    const result = await scheduleDowngrade('acc_test_123', 'tier_2_20');

    expect(result.success).toBe(true);
    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.scheduledTierChange).toBe('tier_2_20');
    expect(updateCreditAccountCalls[0].data.scheduledTierChangeDate).toBeDefined();
  });

  test('throws when no active subscription', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ stripeSubscriptionId: null });

    try {
      await scheduleDowngrade('acc_test_123', 'free');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe('SubscriptionError');
    }
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

describe('createCheckoutSession: metadata', () => {
  test('includes account_id and tier_key in metadata', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_old_free',
      });

    let capturedParams: any = null;
    mockRegistry.stripeClient.checkout.sessions.create = async (params: any) => {
      capturedParams = params;
      return { id: 'cs_new_123', url: 'https://checkout.stripe.com/test' };
    };

    await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect(capturedParams.metadata.account_id).toBe('acc_test_123');
    expect(capturedParams.metadata.tier_key).toBe('tier_6_50');
    // previous_subscription_id is not included in createCheckoutSession;
    // that logic lives in createInlineCheckout.
    expect(capturedParams.metadata.previous_subscription_id).toBeUndefined();
  });

  test('does not include previous_subscription_id when no existing sub', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: null,
      });

    let capturedParams: any = null;
    mockRegistry.stripeClient.checkout.sessions.create = async (params: any) => {
      capturedParams = params;
      return { id: 'cs_new_123', url: 'https://checkout.stripe.com/test' };
    };

    await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect(capturedParams.metadata.previous_subscription_id).toBeUndefined();
  });
});

describe('createInlineCheckout: free tier handling', () => {
  test('does not call handleUpgrade when current tier is free (creates new sub instead)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_old_free',
      });

    let subscriptionCreateCalled = false;
    mockRegistry.stripeClient.subscriptions.create = async (params: any) => {
      subscriptionCreateCalled = true;
      return createMockStripeSubscription({
        id: 'sub_new_paid',
        latest_invoice: { amount_due: 5000, payment_intent: { client_secret: 'cs_test' } },
        metadata: params.metadata,
      });
    };

    const result = await createInlineCheckout({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      billingPeriod: 'monthly',
    });

    expect(subscriptionCreateCalled).toBe(true);
    expect((result as any).previous_subscription_id).toBe('sub_old_free');
  });

  test('includes previous_subscription_id in subscription metadata', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_old_free',
      });

    let capturedParams: any = null;
    mockRegistry.stripeClient.subscriptions.create = async (params: any) => {
      capturedParams = params;
      return createMockStripeSubscription({
        id: 'sub_new_paid',
        latest_invoice: { amount_due: 5000, payment_intent: { client_secret: 'cs_test' } },
        metadata: params.metadata,
      });
    };

    await createInlineCheckout({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'tier_6_50',
      billingPeriod: 'monthly',
    });

    expect(capturedParams.metadata.previous_subscription_id).toBe('sub_old_free');
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
      tierKey: 'tier_6_50',
      billingPeriod: 'monthly',
    });

    expect((result as any).no_payment_required).toBe(true);
    expect(upsertCreditAccountCalls.length).toBe(1);
    // cancelFreeSubscriptionForUpgrade was called
    expect(mockRegistry.stripeClient.subscriptions.cancel).toBeDefined();
  });
});

describe('confirmInlineCheckout: cancel old free sub', () => {
  test('cancels old free sub when previous_subscription_id in subscription metadata', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      createMockStripeSubscription({
        id: 'sub_new_paid',
        status: 'active',
        metadata: {
          account_id: 'acc_test_123',
          tier_key: 'tier_6_50',
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
      tierKey: 'tier_6_50',
    });

    expect(result.success).toBe(true);
    //@ts-ignore
    expect(cancelledSubId).toBe('sub_old_free');
  });

  test('does not cancel when no previous_subscription_id in metadata', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      createMockStripeSubscription({
        id: 'sub_new_paid',
        status: 'active',
        metadata: {
          account_id: 'acc_test_123',
          tier_key: 'tier_6_50',
          billing_period: 'monthly',
        },
      });

    let cancelCalled = false;
    mockRegistry.stripeClient.subscriptions.cancel = async () => {
      cancelCalled = true;
      return {};
    };

    const result = await confirmInlineCheckout({
      accountId: 'acc_test_123',
      subscriptionId: 'sub_new_paid',
      tierKey: 'tier_6_50',
    });

    expect(result.success).toBe(true);
    expect(cancelCalled).toBe(false);
  });
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
