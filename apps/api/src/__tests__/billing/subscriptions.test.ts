import { describe, test, expect, beforeEach, mock } from 'bun:test';
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

// Per-seat checkout reads the active member count for the Stripe quantity.
// Stub it so the unit test doesn't reach for the DB.
mock.module('../../billing/services/seat-management', () => ({
  countActiveMembers: async () => 1,
}));

// ─── Track calls ──────────────────────────────────────────────────────────────

let upsertCreditAccountCalls: any[] = [];
let upsertCustomerCalls: any[] = [];
let resetExpiringCreditsCalls: any[] = [];
let stripeCancelSubCalls: any[] = [];

beforeEach(() => {
  upsertCreditAccountCalls = [];
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
  mockRegistry.updateCreditAccount = async () => {};
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
  createPerSeatCheckoutSession,
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
      tierKey: 'pro',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect((result as any).status).toBe('checkout_created');
    expect((result as any).session_id).toBeDefined();
  });

  test('creates checkout for free-to-pro with an existing free subscription', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_existing',
      });

    const result = await createCheckoutSession({
      accountId: 'acc_test_123',
      email: 'test@example.com',
      tierKey: 'pro',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect((result as any).status).toBe('checkout_created');
  });

  test('resolves the current paid tier price ID', async () => {
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
      tierKey: 'pro',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect(capturedParams).not.toBeNull();
    expect(capturedParams.line_items[0].price_data.unit_amount).toBe(2000);
    expect(capturedParams.line_items[0].price_data.recurring.interval).toBe('month');
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

describe('createCheckoutSession: previous_subscription_id metadata', () => {
  test('includes previous_subscription_id when upgrading from free with existing sub', async () => {
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
      tierKey: 'pro',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect(capturedParams.metadata.previous_subscription_id).toBe('sub_old_free');
    expect(capturedParams.subscription_data.metadata.previous_subscription_id).toBe('sub_old_free');
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
      tierKey: 'pro',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect(capturedParams.metadata.previous_subscription_id).toBeUndefined();
  });
});

describe('cancelFreeSubscriptionForUpgrade', () => {
  test('calls stripe.subscriptions.cancel', async () => {
    const cancelledIds: string[] = [];
    mockRegistry.stripeClient.subscriptions.cancel = async (id: string) => {
      cancelledIds.push(id);
      return {};
    };

    await cancelFreeSubscriptionForUpgrade('sub_old_free', 'acc_test_123');
    expect(cancelledIds).toEqual(['sub_old_free']);
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
