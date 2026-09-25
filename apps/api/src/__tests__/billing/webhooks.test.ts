import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { GrantInput } from '../../billing/wallet';
import {
  createMockCreditAccount,
  createMockStripeSubscription,
  createMockStripeInvoice,
  createMockStripeCheckoutSession,
  createMockStripeEvent,
  createMockStripeClient,
  createMockRevenueCatEvent,
  mockRegistry,
  registerGlobalMocks,
  registerWalletMock,
  fakeWallet,
  resetMockRegistry,
  installWebhookMarkerTable,
} from './mocks';

// Register global mocks + the fake wallet (records every grant and reset)
registerGlobalMocks();
registerWalletMock();

// ─── Track calls ──────────────────────────────────────────────────────────────

const walletGrants = fakeWallet.calls.grant;
const walletResets = fakeWallet.calls.reset;
let upsertCreditAccountCalls: any[] = [];
let updateCreditAccountCalls: any[] = [];
let upsertCustomerCalls: any[] = [];
let stripeCancelSubCalls: any[] = [];

beforeEach(() => {
  walletGrants.length = 0;
  walletResets.length = 0;
  upsertCreditAccountCalls = [];
  updateCreditAccountCalls = [];
  upsertCustomerCalls = [];
  stripeCancelSubCalls = [];
  mintYoloTokensCalls = [];
  resetMockRegistry();

  // Stripe client
  mockRegistry.stripeClient = createMockStripeClient();

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

  // Transaction repo defaults
  mockRegistry.getPurchaseByPaymentIntent = async () => null;
  mockRegistry.updatePurchaseStatus = async () => {};

  // Customer repo defaults
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

  mockRegistry.resolveAccountId = async (userId: string) => userId;

  // Credit service defaults

  // Track stripe.subscriptions.cancel calls (used by cancelFreeSubscriptionForUpgrade)
  mockRegistry.stripeClient.subscriptions.cancel = async (id: string) => {
    stripeCancelSubCalls.push(id);
    return {};
  };
});

// Seat-token minting is a non-money side effect that used to live INSIDE the
// per-seat credit-grant block, so a guard added to the grant silently disabled
// it. Track it so that can never happen again unnoticed.
let mintYoloTokensCalls: string[] = [];
const actualSeatManagement = await import('../../billing/services/seat-management');
mock.module('../../billing/services/seat-management', () => ({
  ...actualSeatManagement,
  mintYoloTokensForAllMembers: async (accountId: string) => {
    mintYoloTokensCalls.push(accountId);
    return { minted: 0 };
  },
}));

// Import AFTER mocking
const { processStripeWebhook, processRevenueCatWebhook } = await import('../../billing/services/webhooks');
const { resolvePerSeatPriceId } = await import('../../billing/services/tiers');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('processStripeWebhook', () => {
  test('throws WebhookError on invalid signature', async () => {
    mockRegistry.stripeClient.webhooks.constructEvent = () => {
      throw new Error('Invalid signature');
    };

    try {
      await processStripeWebhook('body', 'bad_sig');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe('WebhookError');
      expect(err.message).toContain('Signature verification failed');
    }
  });

  test('returns { received: true } for unhandled events', async () => {
    const event = createMockStripeEvent('charge.refunded', {});
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    const result = await processStripeWebhook(JSON.stringify(event), 'sig');
    expect(result).toBeDefined();
    expect(result!.received).toBe(true);
  });
});

describe('checkout.session.completed', () => {
  test('subscription mode: upserts account, grants credits, upserts customer', async () => {
    const session = createMockStripeCheckoutSession();
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_test_123');
    expect(upsertCreditAccountCalls[0].data.tier).toBe('tier_6_50');

    // Only tier_grant ($50) — no machine bonus since no server_type in metadata
    expect(walletGrants.length).toBe(1);
    expect(walletGrants[0].accountId).toBe('acc_test_123');
    expect(walletGrants[0].amount).toBe(50); // tier_6_50 = $50 monthly credits

    expect(upsertCustomerCalls.length).toBe(1);
  });

  test('payment mode: grants non-expiring credits for purchase', async () => {
    const session = createMockStripeCheckoutSession({
      mode: 'payment',
      amount_total: 5000,
      subscription: null,
      payment_intent: 'pi_test_123',
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getPurchaseByPaymentIntent = async () => ({
      id: 'purchase_123',
      status: 'pending',
    });
    const purchaseUpdates: unknown[][] = [];
    mockRegistry.updatePurchaseStatus = async (...args: unknown[]) => {
      purchaseUpdates.push(args);
    };

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(walletGrants.length).toBe(1);
    expect(walletGrants[0].amount).toBe(50);
    expect(walletGrants[0].expiring).toBe(false);
    expect(walletGrants[0].key).toEqual({ event: session.id });
    // The purchase row is found through its PaymentIntent and marked settled.
    expect(purchaseUpdates).toEqual([['purchase_123', 'completed', expect.anything()]]);
  });

  test('skips if missing account_id', async () => {
    const session = createMockStripeCheckoutSession({
      metadata: {},
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(walletGrants.length).toBe(0);
    expect(upsertCreditAccountCalls.length).toBe(0);
  });

  test('skips $0 purchases', async () => {
    const session = createMockStripeCheckoutSession({
      mode: 'payment',
      amount_total: 0,
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(walletGrants.length).toBe(0);
  });

  test('yearly subscription sets nextCreditGrant to 1 month ahead', async () => {
    const session = createMockStripeCheckoutSession({
      metadata: {
        account_id: 'acc_test_123',
        tier_key: 'tier_6_50',
        commitment_type: 'yearly',
      },
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].data.planType).toBe('yearly');
    expect(upsertCreditAccountCalls[0].data.nextCreditGrant).toBeDefined();

    const nextGrant = new Date(upsertCreditAccountCalls[0].data.nextCreditGrant);
    const now = new Date();
    const diffDays = (nextGrant.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(25);
    expect(diffDays).toBeLessThan(35);
  });

  test('subscription.created then checkout.completed share one activation idempotency key', async () => {
    mockRegistry.getCreditAccount = async () => null;

    const subscription = createMockStripeSubscription({ id: 'sub_race_123' });
    mockRegistry.stripeClient.subscriptions.retrieve = async () => subscription;

    const subscriptionEvent = createMockStripeEvent('customer.subscription.created', subscription);
    mockRegistry.stripeClient.webhooks.constructEvent = () => subscriptionEvent;
    await processStripeWebhook(JSON.stringify(subscriptionEvent), 'sig');

    const checkout = createMockStripeCheckoutSession({
      id: 'cs_race_123',
      subscription: 'sub_race_123',
    });
    const checkoutEvent = createMockStripeEvent('checkout.session.completed', checkout);
    mockRegistry.stripeClient.webhooks.constructEvent = () => checkoutEvent;
    await processStripeWebhook(JSON.stringify(checkoutEvent), 'sig');

    expect(walletResets.length).toBe(1);
    expect(walletGrants.length).toBe(1);
    expect(walletResets[0].key).toEqual({ event: 'subscription_activation:sub_race_123' });
    expect(walletGrants[0].key).toEqual({ event: 'subscription_activation:sub_race_123' });
  });
});

// ─── Payment-gated activation ────────────────────────────────────────────────
// Regression suite for the never-paid-subscription hole: the webhook layer used
// to activate on subscription EVENTS, so a checkout whose first invoice was
// never paid still received the paid-tier write AND the activation credit
// grant. Measured on production: 85 accounts on incomplete/incomplete_expired
// subscriptions burned $840 of granted credit without paying anything.

describe('activation is gated on payment', () => {
  test('checkout.session.completed with payment_status=unpaid records the sub pointer ONLY', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      createMockStripeSubscription({ status: 'incomplete' });

    const session = createMockStripeCheckoutSession({ payment_status: 'unpaid' });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // The pointer is factual bookkeeping and IS written.
    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].data.stripeSubscriptionId).toBe('sub_test_123');
    expect(upsertCreditAccountCalls[0].data.stripeSubscriptionStatus).toBe('incomplete');
    expect(upsertCreditAccountCalls[0].data.provider).toBe('stripe');

    // Entitlements and money are NOT.
    expect(upsertCreditAccountCalls[0].data.tier).toBeUndefined();
    expect(walletGrants.length).toBe(0);
    expect(upsertCustomerCalls.length).toBe(0);
  });

  test('invoice.paid(subscription_create) on an active sub performs the full activation', async () => {
    const invoice = createMockStripeInvoice({ billing_reason: 'subscription_create' });
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_test_123');
    expect(upsertCreditAccountCalls[0].data.tier).toBe('tier_6_50');
    expect(upsertCreditAccountCalls[0].data.stripeSubscriptionId).toBe('sub_test_123');

    const tierGrant = walletGrants.find((grant) => grant.kind === 'tier_grant');
    expect(tierGrant).toBeDefined();
    expect(tierGrant!.amount).toBe(50);
    expect(tierGrant!.key).toEqual({ event: 'subscription_activation:sub_test_123' });

    // Customer is stitched from the subscription's customer, with no email.
    expect(upsertCustomerCalls.length).toBe(1);
    expect(upsertCustomerCalls[0].id).toBe('cus_test_123');
  });

  test('invoice.paid(subscription_create) is skipped when the sub is not in a paying status', async () => {
    mockRegistry.stripeClient.subscriptions.retrieve = async () =>
      createMockStripeSubscription({ status: 'incomplete' });

    const invoice = createMockStripeInvoice({ billing_reason: 'subscription_create' });
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(upsertCreditAccountCalls.length).toBe(0);
    expect(walletGrants.length).toBe(0);
  });

  test('invoice.paid(subscription_create) after a paid checkout grants under the same activation key', async () => {
    // Both paths grant with the SAME wallet key, so the ledger applies the
    // second one as a replay (tests/migration/wallet-ledger.test.ts "a replayed
    // event key writes nothing").
    const checkout = createMockStripeCheckoutSession();
    const checkoutEvent = createMockStripeEvent('checkout.session.completed', checkout);
    mockRegistry.stripeClient.webhooks.constructEvent = () => checkoutEvent;
    await processStripeWebhook(JSON.stringify(checkoutEvent), 'sig');

    const invoice = createMockStripeInvoice({ billing_reason: 'subscription_create' });
    const invoiceEvent = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => invoiceEvent;
    await processStripeWebhook(JSON.stringify(invoiceEvent), 'sig');

    expect(walletGrants.map((grant) => grant.key)).toEqual([
      { event: 'subscription_activation:sub_test_123' },
      { event: 'subscription_activation:sub_test_123' },
    ]);
  });

  test('customer.subscription.created with status=incomplete writes no tier and no recovery credits', async () => {
    // An account with no sub pointer on a free tier is exactly the shape that
    // used to earn recovery credits from a subscription that never paid.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ tier: 'free', stripeSubscriptionId: null, balance: '0' });

    const sub = createMockStripeSubscription({ status: 'incomplete' });
    const event = createMockStripeEvent('customer.subscription.created', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.stripeSubscriptionStatus).toBe('incomplete');
    expect(updateCreditAccountCalls[0].data.tier).toBeUndefined();
    expect(walletResets.length).toBe(0);
    expect(walletGrants.length).toBe(0);
  });

  test('a per-seat sub with status=incomplete writes no seat entitlements', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ tier: 'free', billingModel: null, seatCount: 0, stripeSubscriptionId: null });

    const sub = createMockStripeSubscription({
      id: 'sub_seat_incomplete',
      status: 'incomplete',
      metadata: { account_id: 'acc_test_123', tier_key: 'per_seat', billing_model: 'per_seat' },
      items: { data: [{ id: 'si_seat_1', quantity: 5, price: { id: 'price_seat' } }] },
    });
    const event = createMockStripeEvent('customer.subscription.created', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.tier).toBeUndefined();
    expect(updateCreditAccountCalls[0].data.billingModel).toBeUndefined();
    expect(updateCreditAccountCalls[0].data.seatCount).toBeUndefined();
    expect(walletGrants.length).toBe(0);
    expect(walletResets.length).toBe(0);
  });
});

describe('incomplete_expired revokes a never-paid tier', () => {
  test('resets the account to free when it still holds the tier this sub granted', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ stripeSubscriptionId: 'sub_test_123', tier: 'tier_6_50' });

    const sub = createMockStripeSubscription({ id: 'sub_test_123', status: 'incomplete_expired' });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.tier).toBe('free');
    expect(updateCreditAccountCalls[0].data.stripeSubscriptionStatus).toBe('incomplete_expired');
  });

  test('a per-seat account is reset to free and off the per-seat billing model', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_seat_expired',
        tier: 'per_seat',
        billingModel: 'per_seat',
        seatCount: 5,
      });

    const sub = createMockStripeSubscription({
      id: 'sub_seat_expired',
      status: 'incomplete_expired',
      metadata: { account_id: 'acc_test_123', billing_model: 'per_seat' },
      items: { data: [{ id: 'si_seat_1', quantity: 5, price: { id: 'price_seat' } }] },
    });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.tier).toBe('free');
    expect(updateCreditAccountCalls[0].data.billingModel).toBe('legacy');
  });

  test('an enterprise-entitled account is NEVER reset', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_test_123',
        tier: 'tier_6_50',
        enterpriseEntitled: true,
      });

    const sub = createMockStripeSubscription({ id: 'sub_test_123', status: 'incomplete_expired' });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.tier).toBeUndefined();
  });

  test('does not touch a tier this subscription did not grant', async () => {
    // The account moved on to another plan; an old sub expiring unpaid must not
    // strip the tier some other subscription paid for.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ stripeSubscriptionId: 'sub_test_123', tier: 'tier_2_20' });

    const sub = createMockStripeSubscription({ id: 'sub_test_123', status: 'incomplete_expired' });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.tier).toBeUndefined();
  });

});

describe('subscription changes', () => {
  test('updates tier, status, billing cycle anchor', async () => {
    const sub = createMockStripeSubscription();
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data).toMatchObject({
      tier: 'tier_6_50',
      stripeSubscriptionId: 'sub_test_123',
      stripeSubscriptionStatus: 'active',
      billingCycleAnchor: new Date(sub.billing_cycle_anchor * 1000).toISOString(),
    });
  });

  test('sets paymentStatus=cancelling when cancel_at_period_end', async () => {
    const sub = createMockStripeSubscription({ cancel_at_period_end: true });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.paymentStatus).toBe('cancelling');
  });

  test('resolves tier from price ID when metadata missing', async () => {
    const sub = createMockStripeSubscription({
      metadata: { account_id: 'acc_test_123' },
      items: {
        data: [{ id: 'si_123', price: { id: 'price_1TeyA7G6l1KZGqIr7ZhEpoVm' } }],
      },
    });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.tier).toBe('pro');
  });
});

describe('subscription deleted', () => {
  test('reverts to free tier and clears scheduled changes and commitment info', async () => {
    const sub = createMockStripeSubscription();
    const event = createMockStripeEvent('customer.subscription.deleted', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data).toMatchObject({
      tier: 'free',
      stripeSubscriptionStatus: 'canceled',
      scheduledTierChange: null,
      scheduledTierChangeDate: null,
      scheduledPriceId: null,
      commitmentType: null,
      commitmentEndDate: null,
    });
  });

});

describe('invoice.paid (renewal)', () => {
  test('skips non-subscription_cycle invoices', async () => {
    const invoice = createMockStripeInvoice({ billing_reason: 'manual' });
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(walletResets.length).toBe(0);
  });

  test('skips already-processed renewals (idempotency)', async () => {
    const periodStart = Math.floor(Date.now() / 1000);
    const invoice = createMockStripeInvoice({ period_start: periodStart });
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getCreditAccount = async () =>
      // A redelivered invoice carries the SAME period start.
      createMockCreditAccount({
        lastRenewalPeriodStart: periodStart,
      });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(walletResets.length).toBe(0);
  });

  test('resets expiring credits', async () => {
    const invoice = createMockStripeInvoice();
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ lastRenewalPeriodStart: null });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(walletResets.length).toBe(1);
    expect(walletResets[0].accountId).toBe('acc_test_123');
    expect(walletResets[0].amount).toBe(50); // tier_6_50 = $50 monthly credits
    // A renewal writes exactly one ledger entry: the reset.
    expect(walletGrants.length).toBe(0);
  });

  test('applies scheduled downgrade before granting', async () => {
    const invoice = createMockStripeInvoice();
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        scheduledTierChange: 'tier_2_20',
        lastRenewalPeriodStart: null,
      });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    const downgradeCall = updateCreditAccountCalls.find(
      (c: any) => c.data.tier === 'tier_2_20',
    );
    expect(downgradeCall).toBeDefined();
    expect(downgradeCall.data.scheduledTierChange).toBeNull();

    expect(walletResets.length).toBe(1);
    expect(walletResets[0].amount).toBe(20); // tier_2_20 = $20 monthly credits
  });

});

describe('invoice.payment_failed', () => {
  test('sets paymentStatus=past_due', async () => {
    const invoice = createMockStripeInvoice();
    const event = createMockStripeEvent('invoice.payment_failed', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.paymentStatus).toBe('past_due');
    const failedAt = updateCreditAccountCalls[0].data.lastPaymentFailure;
    expect(new Date(failedAt).toISOString()).toBe(failedAt);
  });
});

describe('RevenueCat', () => {
  test('INITIAL_PURCHASE: maps product to tier, grants credits', async () => {
    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      product_id: 'kortix_pro_monthly',
    });

    const result = await processRevenueCatWebhook(body);

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].data.tier).toBe('pro');
    // Pro tier has 0 monthly credits, but gets $5 machine bonus
    expect(walletGrants.length).toBe(1);
    expect(walletGrants[0].amount).toBe(5); // $5 machine bonus
    expect(walletGrants[0].kind).toBe('machine_bonus');
    expect(result.event_type).toBe('INITIAL_PURCHASE');
  });

  test('INITIAL_PURCHASE: legacy tier grants credits + machine bonus', async () => {
    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      product_id: 'kortix_plus_monthly',
    });

    const result = await processRevenueCatWebhook(body);

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].data.tier).toBe('tier_2_20');
    // tier_grant ($20) + machine_bonus ($5)
    expect(walletGrants.length).toBe(2);
    expect(walletGrants[0].amount).toBe(20); // tier_2_20 = $20 monthly credits
    expect(walletGrants[1].amount).toBe(5);  // $5 machine bonus
    expect(result.event_type).toBe('INITIAL_PURCHASE');
  });

  test('duplicate RevenueCat event IDs are idempotent and do not grant twice', async () => {
    installWebhookMarkerTable();

    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      id: 'rc_evt_duplicate_1',
      event_id: 'rc_evt_duplicate_1',
      product_id: 'kortix_plus_monthly',
    });

    const first = await processRevenueCatWebhook(body);
    const second = await processRevenueCatWebhook(body);

    expect((first as any).skipped).toBeUndefined();
    expect((second as any).deduped).toBe(true);
    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(walletGrants.length).toBe(2);
  });

  test('RENEWAL: resets expiring credits', async () => {
    // Default mock has tier from getCreditAccount, which has tier_6_50
    const body = createMockRevenueCatEvent('RENEWAL');

    await processRevenueCatWebhook(body);

    expect(walletResets.length).toBe(1);
    expect(walletResets[0].amount).toBe(50); // tier_6_50 = $50 monthly credits
  });

  test('CANCELLATION: records the cancellation and the period end, and stays active', async () => {
    const expiresAt = Date.now() + 86400000;
    const body = createMockRevenueCatEvent('CANCELLATION', {
      expiration_at_ms: expiresAt,
    });

    await processRevenueCatWebhook(body);

    expect(updateCreditAccountCalls.length).toBe(1);
    const data = updateCreditAccountCalls[0].data;
    expect(new Date(data.revenuecatCancelledAt).toISOString()).toBe(data.revenuecatCancelledAt);
    expect(data.revenuecatCancelAtPeriodEnd).toBe(new Date(expiresAt).toISOString());
    expect(data.paymentStatus).toBe('active');
  });

  test('EXPIRATION: reverts to free', async () => {
    const body = createMockRevenueCatEvent('EXPIRATION');

    await processRevenueCatWebhook(body);
    const freeUpdate = updateCreditAccountCalls.find(
      (c: any) => c.data.tier === 'free',
    );
    expect(freeUpdate).toBeDefined();
  });

  test('UNCANCELLATION: clears cancelled fields', async () => {
    const body = createMockRevenueCatEvent('UNCANCELLATION');

    await processRevenueCatWebhook(body);

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.revenuecatCancelledAt).toBeNull();
    expect(updateCreditAccountCalls[0].data.revenuecatCancelAtPeriodEnd).toBeNull();
  });

  test('PRODUCT_CHANGE with effective_date: stores pending', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const body = createMockRevenueCatEvent('PRODUCT_CHANGE', {
      new_product_id: 'kortix_plus_monthly',
      effective_date: futureDate,
    });

    await processRevenueCatWebhook(body);

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.revenuecatPendingChangeProduct).toBe('kortix_plus_monthly');
    expect(updateCreditAccountCalls[0].data.revenuecatPendingChangeType).toBe('product_change');
  });

  test('PRODUCT_CHANGE without effective_date: applies immediately', async () => {
    const body = createMockRevenueCatEvent('PRODUCT_CHANGE', {
      new_product_id: 'kortix_plus_monthly',
      effective_date: null,
    });

    await processRevenueCatWebhook(body);

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.tier).toBe('tier_2_20');
    expect(updateCreditAccountCalls[0].data.revenuecatProductId).toBe('kortix_plus_monthly');
    expect(updateCreditAccountCalls[0].data.revenuecatPendingChangeProduct).toBeNull();
  });

  test('NON_RENEWING_PURCHASE: grants non-expiring credits', async () => {
    const body = createMockRevenueCatEvent('NON_RENEWING_PURCHASE', {
      price: 25,
    });

    await processRevenueCatWebhook(body);

    expect(walletGrants.length).toBe(1);
    expect(walletGrants[0].amount).toBe(25);
    expect(walletGrants[0].expiring).toBe(false);
  });

  test('BILLING_ISSUE: sets past_due', async () => {
    const body = createMockRevenueCatEvent('BILLING_ISSUE');

    await processRevenueCatWebhook(body);

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.paymentStatus).toBe('past_due');
  });

  test('skips anonymous users', async () => {
    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      app_user_id: '$RCAnonymousID:abc123',
    });

    const result = await processRevenueCatWebhook(body);

    expect(result.skipped).toBe(true);
    expect(walletGrants.length).toBe(0);
  });

  test('throws on missing event', async () => {
    try {
      await processRevenueCatWebhook({});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe('WebhookError');
    }
  });

  test.each([
    ['an event without an id', { type: 'INITIAL_PURCHASE' }, 'Missing event id'],
    ['an event without an app_user_id', { type: 'INITIAL_PURCHASE', id: 'rc_evt_no_user' }, 'Missing app_user_id'],
  ])('throws on %s', async (_name, event, message) => {
    await expect(processRevenueCatWebhook({ event })).rejects.toMatchObject({ name: 'WebhookError', message });
  });

  test('INITIAL_PURCHASE: cancels old Stripe free subscription', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_old_free',
      });

    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      product_id: 'kortix_pro_monthly',
    });

    await processRevenueCatWebhook(body);

    // Should upsert with stripeSubscriptionId: null
    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].data.stripeSubscriptionId).toBeNull();

    // Should cancel old free subscription via stripe
    expect(stripeCancelSubCalls.length).toBe(1);
    expect(stripeCancelSubCalls[0]).toBe('sub_old_free');
  });

  // ─── Deleted accounts + failed-handler replay ─────────────────────────────
  // A RevenueCat store subscription outlives account deletion: Apple/Google
  // keep billing and RevenueCat keeps posting RENEWAL/INITIAL_PURCHASE at us.
  // Without a guard those events re-activate a tier and grant credits on an
  // account the user already deleted.

  test('INITIAL_PURCHASE: skips a deleted account', async () => {
    mockRegistry.getCreditAccount = async () => createMockCreditAccount({ paymentStatus: 'deleted' });

    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      product_id: 'kortix_plus_monthly',
    });

    await processRevenueCatWebhook(body);

    expect(upsertCreditAccountCalls.length).toBe(0);
    expect(walletGrants.length).toBe(0);
  });

  test('RENEWAL: skips a deleted account', async () => {
    mockRegistry.getCreditAccount = async () => createMockCreditAccount({ paymentStatus: 'deleted' });

    const body = createMockRevenueCatEvent('RENEWAL');

    await processRevenueCatWebhook(body);

    expect(walletResets.length).toBe(0);
    expect(updateCreditAccountCalls.length).toBe(0);
  });

  test('NON_RENEWING_PURCHASE: skips a deleted account', async () => {
    mockRegistry.getCreditAccount = async () => createMockCreditAccount({ paymentStatus: 'deleted' });

    const body = createMockRevenueCatEvent('NON_RENEWING_PURCHASE', { price: 25 });

    await processRevenueCatWebhook(body);

    expect(walletGrants.length).toBe(0);
  });

  // The dedupe marker is written only AFTER the handler succeeds. A handler
  // that throws leaves no marker, so RevenueCat's retry runs the handler again
  // instead of being answered "duplicate" with the purchase never applied.
  test('a RevenueCat handler that throws leaves no dedupe marker, and the retry applies the purchase', async () => {
    const markers = installWebhookMarkerTable();
    let failNext = true;
    mockRegistry.upsertCreditAccount = async (id: string, data: any) => {
      if (failNext) {
        failNext = false;
        throw new Error('revenuecat apply failed');
      }
      upsertCreditAccountCalls.push({ accountId: id, data });
    };

    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      id: 'rc_evt_fail_1',
      event_id: 'rc_evt_fail_1',
      product_id: 'kortix_plus_monthly',
    });

    let thrown: any = null;
    try {
      await processRevenueCatWebhook(body);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(String(thrown.message)).toContain('revenuecat apply failed');
    expect(markers.processed.has('revenuecat:rc_evt_fail_1')).toBe(false);

    const retry = await processRevenueCatWebhook(body);
    expect((retry as any).deduped).toBeUndefined();
    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(markers.processed.has('revenuecat:rc_evt_fail_1')).toBe(true);
  });

  // A failed event is REPLAYABLE, so every RevenueCat grant needs a stable
  // idempotency key or the retry double-grants.
  test('grants carry a stable per-event idempotency key', async () => {
    const purchase = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      product_id: 'kortix_plus_monthly',
    });
    await processRevenueCatWebhook(purchase);
    const tierGrant = walletGrants.find((grant) => grant.kind === 'tier_grant');
    expect(tierGrant).toBeDefined();
    expect(tierGrant!.key).toEqual({ event: 'revenuecat:evt_rc_initial_purchase' });

    walletGrants.length = 0;
    const renewal = createMockRevenueCatEvent('RENEWAL');
    await processRevenueCatWebhook(renewal);
    expect(walletResets[0].key).toEqual({ event: 'revenuecat:evt_rc_renewal' });

    walletGrants.length = 0;
    const topup = createMockRevenueCatEvent('NON_RENEWING_PURCHASE', { price: 25 });
    await processRevenueCatWebhook(topup);
    expect(walletGrants[0].key).toEqual({ event: 'revenuecat:evt_rc_non_renewing_purchase' });
  });

  test('INITIAL_PURCHASE: skips cancel when no old Stripe subscription', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: null,
      });

    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      product_id: 'kortix_pro_monthly',
    });

    await processRevenueCatWebhook(body);

    expect(stripeCancelSubCalls.length).toBe(0);
  });
});

// ─── Stale Subscription Guards ──────────────────────────────────────────────

describe('syncSubscriptionState guard', () => {
  test.each(['active', 'incomplete_expired'])(
    'skips a "%s" update when the subscription ID does not match the account current sub',
    async (status) => {
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          stripeSubscriptionId: 'sub_new_paid',
          tier: 'tier_6_50',
        });

      const staleSub = createMockStripeSubscription({
        id: 'sub_old_free',
        status,
        metadata: { account_id: 'acc_test_123', tier_key: 'free' },
      });
      const event = createMockStripeEvent('customer.subscription.updated', staleSub);
      mockRegistry.stripeClient.webhooks.constructEvent = () => event;

      await processStripeWebhook(JSON.stringify(event), 'sig');

      expect(updateCreditAccountCalls.length).toBe(0);
    },
  );

  test('allows update when account has no stripeSubscriptionId', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: null,
      });

    const sub = createMockStripeSubscription();
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
  });
});

describe('handleSubscriptionDeleted guard', () => {
  test('skips revert when deleted subscription ID does not match account current sub', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_new_paid',
        tier: 'tier_6_50',
      });

    const oldSub = createMockStripeSubscription({
      id: 'sub_old_free',
      metadata: { account_id: 'acc_test_123' },
    });
    const event = createMockStripeEvent('customer.subscription.deleted', oldSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should NOT revert to free
    expect(updateCreditAccountCalls.length).toBe(0);
  });

  test('reverts to free when account has no stripeSubscriptionId (e.g. RevenueCat nulled it)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: null,
      });

    const sub = createMockStripeSubscription();
    const event = createMockStripeEvent('customer.subscription.deleted', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.tier).toBe('free');
  });
});

describe('checkout.session.completed: cancel old free sub', () => {
  test('cancels old free subscription when previous_subscription_id in metadata', async () => {
    const session = createMockStripeCheckoutSession({
      metadata: {
        account_id: 'acc_test_123',
        tier_key: 'tier_6_50',
        previous_subscription_id: 'sub_old_free',
      },
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(stripeCancelSubCalls.length).toBe(1);
    expect(stripeCancelSubCalls[0]).toBe('sub_old_free');
  });

  test('does not cancel when no previous_subscription_id in metadata and account is not free', async () => {
    const session = createMockStripeCheckoutSession();
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(stripeCancelSubCalls.length).toBe(0);
  });

  test('cancels old free sub via DB fallback when previous_subscription_id missing from metadata', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_old_free',
      });

    const session = createMockStripeCheckoutSession({
      subscription: 'sub_new_paid',
      metadata: {
        account_id: 'acc_test_123',
        tier_key: 'tier_6_50',
      },
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(stripeCancelSubCalls.length).toBe(1);
    expect(stripeCancelSubCalls[0]).toBe('sub_old_free');
  });

  test('does not cancel when new subscription ID equals old subscription ID', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        stripeSubscriptionId: 'sub_test_123',
      });

    const session = createMockStripeCheckoutSession({
      subscription: 'sub_test_123',
      metadata: {
        account_id: 'acc_test_123',
        tier_key: 'tier_6_50',
      },
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(stripeCancelSubCalls.length).toBe(0);
  });
});

// ─── Orphaned Plan-Sub Recovery ─────────────────────────────────────────────
// Regression tests for the machine-sub hijack bug:
// 1. syncSubscriptionState adopts a live plan sub when the stored sub is dead
// 2. handleSubscriptionDeleted restores another active sub instead of going free
// 3. handleSubscriptionCheckout does not clobber a live plan sub (tested in subscriptions.test.ts)

describe('syncSubscriptionState: orphaned-plan-sub recovery', () => {
  test('adopts incoming live plan sub when stored sub is dead (canceled)', async () => {
    // Account points at a dead machine sub (canceled)
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_dead_machine',
        stripeSubscriptionStatus: 'canceled',
        paymentStatus: 'cancelling',
        tier: 'pro',
        balance: '0',
      });

    // Incoming event is for the still-active annual plan sub
    const livePlanSub = createMockStripeSubscription({
      id: 'sub_live_plan',
      metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
    });
    const event = createMockStripeEvent('customer.subscription.updated', livePlanSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should have adopted the live plan sub (updated the row, not skipped)
    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.stripeSubscriptionId).toBe('sub_live_plan');
    expect(updateCreditAccountCalls[0].data.tier).toBe('tier_2_20');
    expect(updateCreditAccountCalls[0].data.paymentStatus).toBe('active');
  });

  test('adopts incoming live plan sub when stored sub is cancelling', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_dead_machine',
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'cancelling',
        tier: 'pro',
        balance: '0',
      });

    const livePlanSub = createMockStripeSubscription({
      id: 'sub_live_plan',
      metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
    });
    const event = createMockStripeEvent('customer.subscription.updated', livePlanSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.stripeSubscriptionId).toBe('sub_live_plan');
  });

  test('does not adopt machine sub over a dead plan sub', async () => {
    // Even if the stored sub is dead, we should NOT adopt an incoming machine sub
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_dead_plan',
        stripeSubscriptionStatus: 'canceled',
        paymentStatus: 'cancelling',
        tier: 'tier_2_20',
      });

    const machineSub = createMockStripeSubscription({
      id: 'sub_machine_new',
      metadata: { account_id: 'acc_test_123', server_type: 'pro', tier_key: 'pro' },
    });
    const event = createMockStripeEvent('customer.subscription.updated', machineSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should skip — machine sub should not be adopted as plan recovery
    expect(updateCreditAccountCalls.length).toBe(0);
  });
});

describe('handleSubscriptionDeleted: restore other active sub', () => {
  test('restores to another active plan sub instead of reverting to free', async () => {
    // Account points at the machine sub being deleted
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_machine',
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'cancelling',
        tier: 'pro',
      });

    const deletedMachineSub = createMockStripeSubscription({
      id: 'sub_machine',
      customer: 'cus_test_123',
      metadata: { account_id: 'acc_test_123', server_type: 'pro', tier_key: 'pro' },
    });
    const event = createMockStripeEvent('customer.subscription.deleted', deletedMachineSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    // Stripe returns the customer's other active plan sub
    const livePlanSub = createMockStripeSubscription({
      id: 'sub_live_plan',
      status: 'active',
      metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
    });
    mockRegistry.stripeClient.subscriptions.list = async () => ({ data: [livePlanSub] });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should have restored to the plan sub, NOT reverted to free
    const updateCall = updateCreditAccountCalls.find(
      (c: any) => c.data.stripeSubscriptionId === 'sub_live_plan',
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.data.tier).toBe('tier_2_20');

    // Should NOT have reverted to free
    const freeRevert = updateCreditAccountCalls.find((c: any) => c.data.tier === 'free');
    expect(freeRevert).toBeUndefined();
  });

  test('prefers plan sub over machine sub when restoring', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_machine_deleted',
        stripeSubscriptionStatus: 'active',
        tier: 'pro',
      });

    const deletedSub = createMockStripeSubscription({
      id: 'sub_machine_deleted',
      customer: 'cus_test_123',
      metadata: { account_id: 'acc_test_123', server_type: 'pro' },
    });
    const event = createMockStripeEvent('customer.subscription.deleted', deletedSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    // Two other active subs: a machine sub and a plan sub
    const machineSub = createMockStripeSubscription({
      id: 'sub_other_machine',
      status: 'active',
      metadata: { account_id: 'acc_test_123', server_type: 'pro', tier_key: 'pro' },
    });
    const planSub = createMockStripeSubscription({
      id: 'sub_plan',
      status: 'active',
      metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
    });
    mockRegistry.stripeClient.subscriptions.list = async () => ({ data: [machineSub, planSub] });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should restore to the plan sub, not the machine sub
    const planRestore = updateCreditAccountCalls.find(
      (c: any) => c.data.stripeSubscriptionId === 'sub_plan',
    );
    expect(planRestore).toBeDefined();
    expect(planRestore!.data.tier).toBe('tier_2_20');

    const machineRestore = updateCreditAccountCalls.find(
      (c: any) => c.data.stripeSubscriptionId === 'sub_other_machine',
    );
    expect(machineRestore).toBeUndefined();
  });

  test('falls through to revertToFree when Stripe list fails', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_machine',
        stripeSubscriptionStatus: 'active',
        tier: 'pro',
      });

    const deletedSub = createMockStripeSubscription({
      id: 'sub_machine',
      customer: 'cus_test_123',
    });
    const event = createMockStripeEvent('customer.subscription.deleted', deletedSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    // Stripe list throws
    mockRegistry.stripeClient.subscriptions.list = async () => {
      throw new Error('Stripe API error');
    };

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should fall through to revertToFree
    const freeRevert = updateCreditAccountCalls.find((c: any) => c.data.tier === 'free');
    expect(freeRevert).toBeDefined();
  });
});

describe('per-seat entitlement is the allowance, never the price', () => {
  function perSeatSub(seats: number, overrides: Record<string, any> = {}) {
    return createMockStripeSubscription({
      id: 'sub_seats_1',
      metadata: {
        account_id: 'acc_test_123',
        tier_key: 'per_seat',
        billing_model: 'per_seat',
      },
      items: {
        data: [
          {
            id: 'si_seat_1',
            quantity: seats,
            price: { id: 'price_seat', unit_amount: 4000, currency: 'usd' },
          },
        ],
      },
      ...overrides,
    });
  }

  async function syncSeats(sub: any) {
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;
    await processStripeWebhook(JSON.stringify(event), 'sig');
  }

  test('a recovering per-seat team is reset to its FULL seat allowance, not a flat $25', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        billingModel: 'per_seat',
        seatCount: 0,
        stripeSubscriptionId: null,
      });

    await syncSeats(perSeatSub(6));

    expect(walletResets.length).toBe(1);
    expect(walletResets[0].amount).toBe(150);
    // The reset funds every seat; no separate grant is written.
    expect(walletGrants.length).toBe(0);
  });

  // Stripe can report a seat line with quantity 0 or a fraction; the team is
  // still funded for at least one whole seat.
  test.each([
    [0, 1, 25],
    [2.9, 2, 50],
  ])('a seat line with quantity %p is stored as %p seats and funds %p', async (seats, stored, amount) => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        billingModel: 'per_seat',
        seatCount: 0,
        stripeSubscriptionId: null,
      });

    await syncSeats(perSeatSub(seats));

    const persisted = updateCreditAccountCalls.find((c: any) => c.data.seatCount !== undefined);
    expect(persisted?.data.seatCount).toBe(stored);
    expect(walletResets.map((reset) => reset.amount)).toEqual([amount]);
  });

  test('a brand-new per-seat team gets seat tokens minted even though no grant is written', async () => {
    // Minting is not a money decision. It once sat inside a credit-grant block,
    // so a change to the grant rule silently stopped minting for newly
    // activated teams — the exact case the mint exists for.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        billingModel: null,
        seatCount: 0,
        stripeSubscriptionId: null,
      });

    await syncSeats(perSeatSub(6));

    expect(walletGrants.length).toBe(0);
    expect(mintYoloTokensCalls).toEqual(['acc_test_123']);
  });

  test('a legacy tier recovery is still sized by the tier, not by seats', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ tier: 'free', stripeSubscriptionId: null, seatCount: 0 });

    const sub = createMockStripeSubscription({ id: 'sub_legacy_recover' });
    await syncSeats(sub);

    expect(walletResets.length).toBe(1);
    expect(walletResets[0].amount).toBe(50);
  });
});

// ─── Money-first settlement ──────────────────────────────────────────────────

async function deliverStripe(type: string, object: any, overrides: Record<string, any> = {}) {
  const event = createMockStripeEvent(type, object, overrides);
  mockRegistry.stripeClient.webhooks.constructEvent = () => event;
  return processStripeWebhook(JSON.stringify(event), 'sig');
}

describe('credit purchases grant only settled money', () => {
  function purchaseSession(overrides: Record<string, any> = {}) {
    return createMockStripeCheckoutSession({
      id: 'cs_purchase_1',
      mode: 'payment',
      subscription: null,
      amount_total: 2500,
      payment_intent: null,
      metadata: { account_id: 'acc_test_123', type: 'credit_purchase', purchase_id: '11111111-2222-4333-8444-555555555555' },
      ...overrides,
    });
  }

  test('async_payment_succeeded grants the purchase once, keyed on the session id', async () => {
    const statusCalls: any[] = [];
    mockRegistry.updatePurchaseStatus = async (...args: any[]) => {
      statusCalls.push(args);
    };

    await deliverStripe('checkout.session.completed', purchaseSession({ payment_status: 'unpaid' }));
    await deliverStripe('checkout.session.async_payment_succeeded', purchaseSession({ payment_status: 'paid' }));

    expect(walletGrants.length).toBe(1);
    expect(walletGrants[0].amount).toBe(25);
    expect(walletGrants[0].kind).toBe('purchase');
    expect(walletGrants[0].expiring).toBe(false);
    expect(walletGrants[0].key).toEqual({ event: 'cs_purchase_1' });
    expect(statusCalls[0][0]).toBe('11111111-2222-4333-8444-555555555555');
    expect(statusCalls[0][1]).toBe('completed');
  });

  test('async_payment_failed grants nothing and marks the purchase failed', async () => {
    const statusCalls: any[] = [];
    mockRegistry.updatePurchaseStatus = async (...args: any[]) => {
      statusCalls.push(args);
    };

    await deliverStripe('checkout.session.async_payment_failed', purchaseSession({ payment_status: 'unpaid' }));

    expect(walletGrants.length).toBe(0);
    expect(statusCalls).toEqual([['11111111-2222-4333-8444-555555555555', 'failed', undefined]]);
  });
});

describe('the Stripe dedupe marker is written only after the handler succeeds', () => {
  test('a successful event is checked first and recorded last', async () => {
    const markers = installWebhookMarkerTable();
    let grantedBeforeRecord = false;
    fakeWallet.wallet.grant = async (input) => {
      walletGrants.push(input);
      grantedBeforeRecord = !markers.order.some((entry) => entry.startsWith('record:'));
      return { replayed: false, ledgerId: 'ledger_test' };
    };

    const session = createMockStripeCheckoutSession({ mode: 'payment', subscription: null, amount_total: 1000 });
    await deliverStripe('checkout.session.completed', session, { id: 'evt_order_1' });

    expect(markers.order).toEqual(['check:evt_order_1', 'record:evt_order_1']);
    expect(grantedBeforeRecord).toBe(true);
  });

  test('a handler that throws leaves no marker, and the redelivery runs the handler', async () => {
    const markers = installWebhookMarkerTable();
    let failNext = true;
    fakeWallet.wallet.grant = async (input) => {
      if (failNext) {
        failNext = false;
        throw new Error('grant transport failure');
      }
      walletGrants.push(input);
      return { replayed: false, ledgerId: 'ledger_test' };
    };

    const session = createMockStripeCheckoutSession({ mode: 'payment', subscription: null, amount_total: 1000 });
    const event = createMockStripeEvent('checkout.session.completed', session, { id: 'evt_retry_1' });
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await expect(processStripeWebhook(JSON.stringify(event), 'sig')).rejects.toThrow('grant transport failure');
    expect(markers.processed.has('evt_retry_1')).toBe(false);

    const retry = await processStripeWebhook(JSON.stringify(event), 'sig');
    expect((retry as any).deduped).toBeUndefined();
    expect(walletGrants.length).toBe(1);

    const writesBeforeReplay = updateCreditAccountCalls.length + upsertCreditAccountCalls.length;
    const replay = await processStripeWebhook(JSON.stringify(event), 'sig');
    expect((replay as any).deduped).toBe(true);
    expect(walletGrants.length).toBe(1);
    // The replay short-circuits before any reconciliation.
    expect(updateCreditAccountCalls.length + upsertCreditAccountCalls.length).toBe(writesBeforeReplay);
  });
});

describe('auto-topup settles on payment_intent webhooks', () => {
  function autoTopupIntent(overrides: Record<string, any> = {}) {
    return {
      id: 'pi_topup_1',
      object: 'payment_intent',
      status: 'succeeded',
      amount: 2000,
      amount_received: 2000,
      metadata: { account_id: 'acc_test_123', type: 'auto_topup', amount: '20' },
      last_payment_error: null,
      ...overrides,
    };
  }

  test('payment_intent.succeeded grants the auto-topup keyed on the PaymentIntent id', async () => {
    await deliverStripe('payment_intent.succeeded', autoTopupIntent());

    expect(walletGrants.length).toBe(1);
    expect(walletGrants[0].accountId).toBe('acc_test_123');
    expect(walletGrants[0].amount).toBe(20);
    expect(walletGrants[0].expiring).toBe(false);
    expect(walletGrants[0].key).toEqual({ event: 'pi_topup_1' });
    const reset = updateCreditAccountCalls.find((c: any) => c.data.autoTopupConsecutiveFailures === 0);
    expect(reset).toBeDefined();
  });

});

describe('invoice.paid (subscription_update): mid-period changes are funded by the paid proration', () => {
  const SEAT_PRICE = 'price_1TeyA7G6l1KZGqIrTb2DKGS0';

  function prorationInvoice(lines: Array<{ amount: number; price: string }>, overrides: Record<string, any> = {}) {
    return createMockStripeInvoice({
      id: 'in_proration_1',
      billing_reason: 'subscription_update',
      status: 'paid',
      lines: {
        data: lines.map((line) => ({ amount: line.amount, proration: true, price: { id: line.price } })),
        has_more: false,
      },
      ...overrides,
    });
  }

  test('added seats: the paid prorated charge buys the $25-of-$40 allowance share', async () => {
    // 2 → 5 seats with 3/4 of the period left: -$60 unused + $150 new = $90.
    await deliverStripe('invoice.paid', prorationInvoice([
      { amount: -6000, price: SEAT_PRICE },
      { amount: 15000, price: SEAT_PRICE },
    ]));

    expect(walletGrants.length).toBe(1);
    expect(walletGrants[0].amount).toBe(56.25);
    expect(walletGrants[0].kind).toBe('seat_grant');
    expect(walletGrants[0].expiring).toBe(true);
    expect(walletGrants[0].key).toEqual({ event: 'proration_grant:in_proration_1' });
    // A mid-period change grants; it never RESETS the wallet.
    expect(walletResets.length).toBe(0);
  });

  test('an invoice that is not paid grants nothing', async () => {
    await deliverStripe('invoice.paid', prorationInvoice([
      { amount: -6000, price: SEAT_PRICE },
      { amount: 15000, price: SEAT_PRICE },
    ], { status: 'open' }));
    expect(walletGrants.length).toBe(0);
  });

});

// ─── Per-seat subscription reconciliation ───────────────────────────────────
// `customer.subscription.*` events that carry a per-seat item reconcile
// seat_count, billing_model and the seat item id. A quantity change alone grants
// NO allowance: seats added mid-period are funded from the PAID proration
// invoice (proration-grants.ts), not here.

describe('per-seat subscription reconciliation', () => {
  /** Reaches the per-seat branch through metadata.billing_model, not the price. */
  const NOT_THE_SEAT_PRICE = 'price_not_the_seat_price';

  beforeEach(() => {
    // Default: per-seat account with 1 seat already.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        billingModel: 'per_seat',
        seatCount: 1,
        seatSubscriptionItemId: 'si_seat_123',
        tier: 'per_seat',
        stripeSubscriptionId: 'sub_seat_123',
        autoTopupCustomized: false,
      });
  });

  function perSeatSubscription(quantity: number, overrides: Record<string, any> = {}) {
    return createMockStripeSubscription({
      id: 'sub_seat_123',
      items: {
        data: [
          {
            id: 'si_seat_123',
            quantity,
            price: { id: NOT_THE_SEAT_PRICE, unit_amount: 2000, currency: 'usd' },
          },
        ],
      },
      metadata: {
        account_id: 'acc_test_123',
        tier_key: 'per_seat',
        billing_model: 'per_seat',
      },
      ...overrides,
    });
  }

  describe('per-seat webhook reconciliation', () => {
    test('quantity 1 → 3: seat_count updates and no allowance is granted from the quantity change', async () => {
      const sub = perSeatSubscription(3);
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const persistedUpdate = [...updateCreditAccountCalls, ...upsertCreditAccountCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
        .find((c) => c.data.seatCount !== undefined);
      expect(persistedUpdate).toBeDefined();
      expect(persistedUpdate?.data.seatCount).toBe(3);
      expect(persistedUpdate?.data.billingModel).toBe('per_seat');
      expect(persistedUpdate?.data.seatSubscriptionItemId).toBe('si_seat_123');

      // The added seats are funded when their proration invoice is PAID
      // (invoice.paid, billing_reason subscription_update), never here.
      expect(walletGrants.length).toBe(0);
      expect(walletResets.length).toBe(0);
    });

    test.each([
      // 5 seats × $5 threshold-per-seat = $25; × $20 amount-per-seat = $100.
      [false, { autoTopupThreshold: '25', autoTopupAmount: '100' }],
      [true, { autoTopupThreshold: undefined, autoTopupAmount: undefined }],
    ])('auto-topup defaults rescale with the seat count unless the user customized them (customized: %p)', async (customized, expected) => {
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          billingModel: 'per_seat',
          seatCount: 1,
          seatSubscriptionItemId: 'si_seat_123',
          tier: 'per_seat',
          stripeSubscriptionId: 'sub_seat_123',
          autoTopupCustomized: customized,
        });
      const sub = perSeatSubscription(5);
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const seatWrite = updateCreditAccountCalls.find((c) => c.data.seatCount === 5);
      expect(seatWrite?.data.autoTopupThreshold).toBe(expected.autoTopupThreshold);
      expect(seatWrite?.data.autoTopupAmount).toBe(expected.autoTopupAmount);
    });

    test('quantity DECREASE: no grant emitted', async () => {
      // Start with 3 seats; drop to 1.
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          billingModel: 'per_seat',
          seatCount: 3,
          seatSubscriptionItemId: 'si_seat_123',
          tier: 'per_seat',
          stripeSubscriptionId: 'sub_seat_123',
        });

      const sub = perSeatSubscription(1);
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      expect(walletGrants.length).toBe(0);
      const persistedUpdate = updateCreditAccountCalls.find((c) => c.data.seatCount !== undefined);
      expect(persistedUpdate?.data.seatCount).toBe(1);
    });

    test('same quantity (no change) → no grant, but seat_subscription_item_id still synced', async () => {
      const sub = perSeatSubscription(1);
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      expect(walletGrants.length).toBe(0);
      const seatWrite = updateCreditAccountCalls.find((c) => c.data.seatCount !== undefined);
      expect(seatWrite?.data).toMatchObject({ seatCount: 1, seatSubscriptionItemId: 'si_seat_123' });
    });

    test('legacy subscription (no per-seat item) — billing_model unchanged, no seat fields touched', async () => {
      // Account currently legacy.
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          billingModel: 'legacy',
          tier: 'tier_2_20',
          seatCount: 1,
          stripeSubscriptionId: 'sub_legacy_1',
        });

      const legacySub = createMockStripeSubscription({
        id: 'sub_legacy_1',
        items: {
          data: [
            {
              id: 'si_legacy_1',
              quantity: 1,
              price: { id: 'price_legacy_unknown', unit_amount: 2000, currency: 'usd' },
            },
          ],
        },
        metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
      });
      const event = createMockStripeEvent('customer.subscription.updated', legacySub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      // The subscription write happens, without any seat field.
      expect(updateCreditAccountCalls.some((c) => c.data.stripeSubscriptionId === 'sub_legacy_1')).toBe(true);
      // No seat grant for legacy customers.
      expect(walletGrants.length).toBe(0);
      // No update should set seatCount / billingModel='per_seat'.
      const seatTouchingUpdate = updateCreditAccountCalls.find(
        (c) => c.data.seatCount !== undefined || c.data.billingModel === 'per_seat',
      );
      expect(seatTouchingUpdate).toBeUndefined();
    });

    test('a subscription on the per-seat price reconciles seats without any billing_model metadata', async () => {
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          billingModel: 'per_seat',
          seatCount: 1,
          seatSubscriptionItemId: 'si_seat_by_price',
          stripeSubscriptionId: 'sub_seat_by_price',
          tier: 'per_seat',
        });

      const sub = createMockStripeSubscription({
        id: 'sub_seat_by_price',
        items: {
          data: [
            {
              id: 'si_seat_by_price',
              quantity: 4,
              price: { id: resolvePerSeatPriceId(), unit_amount: 4000, currency: 'usd' },
            },
          ],
        },
        metadata: { account_id: 'acc_test_123' },
      });
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const seatUpdate = updateCreditAccountCalls.find((c) => c.data.seatCount === 4);
      expect(seatUpdate?.data).toMatchObject({ billingModel: 'per_seat', seatSubscriptionItemId: 'si_seat_by_price' });
      expect(walletGrants.length).toBe(0);
    });
  });

  describe('legacy → per-seat adoption (regression)', () => {
    // A legacy/machine account migrates to per-seat. The new per-seat sub has a
    // different id and carries metadata.billing_model='per_seat' but no tier_key /
    // previous_subscription_id, so the stale-sub guard used to drop it — stranding
    // the account on the (now cancelled) machine sub: tier=free, project-capped.
    test('legacy/machine account adopts an incoming active per-seat sub instead of skipping it', async () => {
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          billingModel: 'legacy',
          tier: 'free',
          seatCount: 0,
          stripeSubscriptionId: 'sub_machine_legacy',
        });

      const perSeatSub = createMockStripeSubscription({
        id: 'sub_perseat_new',
        status: 'active',
        items: { data: [{ id: 'si_perseat_new', quantity: 1, price: { id: 'price_arbitrary', unit_amount: 4000, currency: 'usd' } }] },
        metadata: { account_id: 'acc_test_123', billing_model: 'per_seat' },
      });
      const event = createMockStripeEvent('customer.subscription.created', perSeatSub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const adopt = [...updateCreditAccountCalls, ...upsertCreditAccountCalls].find((c) => c.data.billingModel === 'per_seat');
      expect(adopt).toBeDefined();
      expect(adopt?.data.stripeSubscriptionId).toBe('sub_perseat_new');
      expect(adopt?.data.seatSubscriptionItemId).toBe('si_perseat_new');
      expect(adopt?.data.tier).toBe('per_seat');
    });

    test('a genuinely stale non-per-seat sub is still skipped (guard intact)', async () => {
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          billingModel: 'per_seat',
          tier: 'per_seat',
          seatCount: 1,
          seatSubscriptionItemId: 'si_perseat_current',
          stripeSubscriptionId: 'sub_perseat_current',
        });

      const staleSub = createMockStripeSubscription({
        id: 'sub_other_unrelated',
        status: 'active',
        items: { data: [{ id: 'si_other', quantity: 1, price: { id: 'price_legacy_unknown', unit_amount: 2000, currency: 'usd' } }] },
        metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
      });
      const event = createMockStripeEvent('customer.subscription.updated', staleSub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const clobber = updateCreditAccountCalls.find((c) => c.data.stripeSubscriptionId === 'sub_other_unrelated');
      expect(clobber).toBeUndefined();
    });

    describe('enterprise + per-seat coexistence — tier not clobbered', () => {
      test('enterprise_entitled=true + per-seat sub update → billing_model reconciled, tier NOT set to per_seat', async () => {
        // The contracted shape: enterprise entitlements (via flag)
        // + a per-seat Stripe subscription. An ordinary seat-quantity update lands.
        mockRegistry.getCreditAccount = async () =>
          createMockCreditAccount({
            tier: 'enterprise',
            enterpriseEntitled: true,
            billingModel: 'per_seat',
            seatCount: 2,
            seatSubscriptionItemId: 'si_seat_123',
            stripeSubscriptionId: 'sub_seat_123',
            autoTopupCustomized: true,
          });

        // Webhook fires for a seat-count change 2 → 4 — the ordinary update path
        // that used to strip enterprise entitlements.
        const sub = perSeatSubscription(4);
        const event = createMockStripeEvent('customer.subscription.updated', sub);

        await processStripeWebhook(JSON.stringify(event), 'whsec_test');

        const persisted = [...updateCreditAccountCalls, ...upsertCreditAccountCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
          .find((c) => c.data.seatCount !== undefined);
        expect(persisted).toBeDefined();
        // Per-seat billing semantics ARE reconciled:
        expect(persisted?.data.billingModel).toBe('per_seat');
        expect(persisted?.data.seatCount).toBe(4);
        expect(persisted?.data.seatSubscriptionItemId).toBe('si_seat_123');
        // But tier is NOT clobbered to 'per_seat' — the key fix. The update must
        // not carry a `tier` write at all (enterprise tier is preserved).
        expect(persisted?.data.tier).toBeUndefined();
        // And the added seats earn no unpaid allowance here either.
        expect(walletGrants.length).toBe(0);
      });

      test('non-enterprise per-seat account → tier still set to per_seat (unchanged behaviour)', async () => {
        // The guard must NOT change behaviour for ordinary per-seat accounts
        // (no enterprise entitlement): tier='per_seat' is still written, exactly
        // as before. This is the regression guard for the common case.
        mockRegistry.getCreditAccount = async () =>
          createMockCreditAccount({
            tier: 'free',
            enterpriseEntitled: false,
            billingModel: 'per_seat',
            seatCount: 1,
            seatSubscriptionItemId: 'si_seat_123',
            stripeSubscriptionId: 'sub_seat_123',
            autoTopupCustomized: true,
          });

        const sub = perSeatSubscription(3);
        const event = createMockStripeEvent('customer.subscription.updated', sub);

        await processStripeWebhook(JSON.stringify(event), 'whsec_test');

        const persisted = [...updateCreditAccountCalls, ...upsertCreditAccountCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
          .find((c) => c.data.seatCount !== undefined);
        expect(persisted).toBeDefined();
        expect(persisted?.data.billingModel).toBe('per_seat');
        expect(persisted?.data.seatCount).toBe(3);
        // tier IS clobbered to per_seat for ordinary accounts — unchanged.
        expect(persisted?.data.tier).toBe('per_seat');
      });

      test('enterprise_entitled=true, no existing per-seat → first per-seat webhook still does NOT set tier', async () => {
        // An operator flags the account enterprise_entitled at sign-up (tier is
        // still 'free', no per-seat sub yet). The customer then buys a per-seat
        // subscription. The activation webhook must adopt the sub + reconcile
        // billing, but NOT flip tier to per_seat.
        mockRegistry.getCreditAccount = async () =>
          createMockCreditAccount({
            tier: 'free',
            enterpriseEntitled: true,
            billingModel: 'legacy',
            seatCount: 0,
            stripeSubscriptionId: null,
            autoTopupCustomized: false,
          });

        const sub = perSeatSubscription(2);
        const event = createMockStripeEvent('customer.subscription.created', sub);

        await processStripeWebhook(JSON.stringify(event), 'whsec_test');

        const persisted = [...updateCreditAccountCalls, ...upsertCreditAccountCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
          .find((c) => c.data.billingModel === 'per_seat');
        expect(persisted).toBeDefined();
        expect(persisted?.data.billingModel).toBe('per_seat');
        expect(persisted?.data.seatCount).toBe(2);
        // The free → per_seat activation must NOT clobber tier for an
        // enterprise-entitled account; entitlements stay sourced from the flag.
        expect(persisted?.data.tier).toBeUndefined();
      });
    });
  });
});
