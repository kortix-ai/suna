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
  cancelSubscription,
  reactivateSubscription,
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
