import { describe, test, expect, beforeEach, mock } from 'bun:test';
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
  registerCreditsMock,
  resetMockRegistry,
} from './mocks';

// Register global mocks + credits service mock (stubs grantCredits/resetExpiringCredits)
registerGlobalMocks();
registerCreditsMock();

// ─── Track calls ──────────────────────────────────────────────────────────────

let grantCreditsCalls: any[] = [];
let resetExpiringCreditsCalls: any[] = [];
let insertLedgerCalls: any[] = [];
let upsertCreditAccountCalls: any[] = [];
let updateCreditAccountCalls: any[] = [];
let upsertCustomerCalls: any[] = [];
let stripeCancelSubCalls: any[] = [];

beforeEach(() => {
  grantCreditsCalls = [];
  resetExpiringCreditsCalls = [];
  insertLedgerCalls = [];
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
  mockRegistry.insertLedgerEntry = async (data: any) => {
    insertLedgerCalls.push(data);
    return { id: 'ledger_test', ...data };
  };
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
  mockRegistry.grantCredits = async (...args: any[]) => {
    grantCreditsCalls.push(args);
  };
  mockRegistry.resetExpiringCredits = async (...args: any[]) => {
    resetExpiringCreditsCalls.push(args);
  };

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

  test('routes each event type to correct handler', async () => {
    const event = createMockStripeEvent('some.unknown.event', {});
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    const result = await processStripeWebhook(JSON.stringify(event), 'valid_sig');
    expect(result).toBeDefined();
    expect(result!.received).toBe(true);
    expect((result as any).event_type).toBe('some.unknown.event');
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
    expect(grantCreditsCalls.length).toBe(1);
    expect(grantCreditsCalls[0][0]).toBe('acc_test_123');
    expect(grantCreditsCalls[0][1]).toBe(50); // tier_6_50 = $50 monthly credits

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

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(grantCreditsCalls.length).toBe(1);
    expect(grantCreditsCalls[0][1]).toBe(50);
    expect(grantCreditsCalls[0][4]).toBe(false);
  });

  test('skips if missing account_id', async () => {
    const session = createMockStripeCheckoutSession({
      metadata: {},
    });
    const event = createMockStripeEvent('checkout.session.completed', session);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(grantCreditsCalls.length).toBe(0);
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

    expect(grantCreditsCalls.length).toBe(0);
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

    expect(resetExpiringCreditsCalls.length).toBe(1);
    expect(grantCreditsCalls.length).toBe(1);
    expect(resetExpiringCreditsCalls[0][3]).toBe('subscription_activation:sub_race_123');
    expect(grantCreditsCalls[0][5]).toBe('subscription_activation:sub_race_123');
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
    expect(grantCreditsCalls.length).toBe(0);
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

    const tierGrant = grantCreditsCalls.find((c: any) => c[2] === 'tier_grant');
    expect(tierGrant).toBeDefined();
    expect(tierGrant[1]).toBe(50);
    expect(tierGrant[5]).toBe('subscription_activation:sub_test_123');

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
    expect(grantCreditsCalls.length).toBe(0);
  });

  test('invoice.paid(subscription_create) after a paid checkout does NOT grant twice', async () => {
    // Both paths call grantCredits with the SAME idempotency key, so the credits
    // ledger collapses them. Model that here: the stub grants once per key and
    // records the effective grants.
    const grantedKeys = new Set<string>();
    const effectiveGrants: any[] = [];
    mockRegistry.grantCredits = async (...args: any[]) => {
      grantCreditsCalls.push(args);
      const key = args[5];
      if (key && grantedKeys.has(key)) return;
      if (key) grantedKeys.add(key);
      effectiveGrants.push(args);
    };

    const checkout = createMockStripeCheckoutSession();
    const checkoutEvent = createMockStripeEvent('checkout.session.completed', checkout);
    mockRegistry.stripeClient.webhooks.constructEvent = () => checkoutEvent;
    await processStripeWebhook(JSON.stringify(checkoutEvent), 'sig');

    const invoice = createMockStripeInvoice({ billing_reason: 'subscription_create' });
    const invoiceEvent = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => invoiceEvent;
    await processStripeWebhook(JSON.stringify(invoiceEvent), 'sig');

    expect(grantCreditsCalls.length).toBe(2);
    expect(grantCreditsCalls[0][5]).toBe('subscription_activation:sub_test_123');
    expect(grantCreditsCalls[1][5]).toBe(grantCreditsCalls[0][5]);
    expect(effectiveGrants.length).toBe(1);
    expect(effectiveGrants[0][1]).toBe(50);
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
    expect(resetExpiringCreditsCalls.length).toBe(0);
    expect(grantCreditsCalls.length).toBe(0);
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
    expect(grantCreditsCalls.filter((c: any) => c[2] === 'seat_grant').length).toBe(0);
    expect(resetExpiringCreditsCalls.length).toBe(0);
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

  test('does not touch an account that points at a different subscription', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ stripeSubscriptionId: 'sub_live_other', tier: 'tier_6_50' });

    const sub = createMockStripeSubscription({ id: 'sub_expired', status: 'incomplete_expired' });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Stale-sub guard bails before any write.
    expect(updateCreditAccountCalls.length).toBe(0);
  });
});

describe('subscription changes', () => {
  test('updates tier, status, billing cycle anchor', async () => {
    const sub = createMockStripeSubscription();
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.stripeSubscriptionId).toBe('sub_test_123');
    expect(updateCreditAccountCalls[0].data.stripeSubscriptionStatus).toBe('active');
    expect(updateCreditAccountCalls[0].data.billingCycleAnchor).toBeDefined();
  });

  test('sets paymentStatus=cancelling when cancel_at_period_end', async () => {
    const sub = createMockStripeSubscription({ cancel_at_period_end: true });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.paymentStatus).toBe('cancelling');
  });

  test('falls back to customer lookup when no account_id in metadata', async () => {
    const sub = createMockStripeSubscription({
      metadata: {},
      customer: 'cus_test_123',
    });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getCustomerByStripeId = async () => ({
      id: 'cus_test_123',
      accountId: 'acc_from_customer',
      email: 'test@example.com',
      provider: 'stripe',
      active: true,
    });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].accountId).toBe('acc_from_customer');
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
  test('reverts to free tier', async () => {
    const sub = createMockStripeSubscription();
    const event = createMockStripeEvent('customer.subscription.deleted', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.tier).toBe('free');
    expect(updateCreditAccountCalls[0].data.stripeSubscriptionStatus).toBe('canceled');
  });

  test('clears scheduled changes and commitment info', async () => {
    const sub = createMockStripeSubscription();
    const event = createMockStripeEvent('customer.subscription.deleted', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.scheduledTierChange).toBeNull();
    expect(updateCreditAccountCalls[0].data.scheduledTierChangeDate).toBeNull();
    expect(updateCreditAccountCalls[0].data.scheduledPriceId).toBeNull();
    expect(updateCreditAccountCalls[0].data.commitmentType).toBeNull();
    expect(updateCreditAccountCalls[0].data.commitmentEndDate).toBeNull();
  });
});

describe('invoice.paid (renewal)', () => {
  test('skips non-subscription_cycle invoices', async () => {
    const invoice = createMockStripeInvoice({ billing_reason: 'manual' });
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(resetExpiringCreditsCalls.length).toBe(0);
  });

  test('skips already-processed renewals (idempotency)', async () => {
    const periodStart = Math.floor(Date.now() / 1000);
    const invoice = createMockStripeInvoice({ period_start: periodStart });
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        lastRenewalPeriodStart: periodStart + 1,
      });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(resetExpiringCreditsCalls.length).toBe(0);
  });

  test('resets expiring credits', async () => {
    const invoice = createMockStripeInvoice();
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ lastRenewalPeriodStart: null });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(resetExpiringCreditsCalls.length).toBe(1);
    expect(resetExpiringCreditsCalls[0][0]).toBe('acc_test_123');
    expect(resetExpiringCreditsCalls[0][1]).toBe(50); // tier_6_50 = $50 monthly credits
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

    expect(resetExpiringCreditsCalls.length).toBe(1);
    expect(resetExpiringCreditsCalls[0][1]).toBe(20); // tier_2_20 = $20 monthly credits
  });

  test('does NOT create duplicate ledger entry (only RPC creates it)', async () => {
    const invoice = createMockStripeInvoice();
    const event = createMockStripeEvent('invoice.paid', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ lastRenewalPeriodStart: null });

    await processStripeWebhook(JSON.stringify(event), 'sig');
    expect(insertLedgerCalls.length).toBe(0);
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
  });

  test('records lastPaymentFailure', async () => {
    const invoice = createMockStripeInvoice();
    const event = createMockStripeEvent('invoice.payment_failed', invoice);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.lastPaymentFailure).toBeDefined();
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
    expect(grantCreditsCalls.length).toBe(1);
    expect(grantCreditsCalls[0][1]).toBe(5); // $5 machine bonus
    expect(grantCreditsCalls[0][2]).toBe('machine_bonus');
    expect(result.event_type).toBe('INITIAL_PURCHASE');
  });

  test('INITIAL_PURCHASE: resolves app_user_id to canonical account_id', async () => {
    mockRegistry.resolveAccountId = async () => 'acc_canonical_123';

    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      app_user_id: 'user_legacy_123',
      product_id: 'kortix_plus_monthly',
    });

    const result = await processRevenueCatWebhook(body);

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_canonical_123');
    expect(grantCreditsCalls[0][0]).toBe('acc_canonical_123');
    expect((result as any).account_id).toBe('acc_canonical_123');
  });

  test('INITIAL_PURCHASE: legacy tier grants credits + machine bonus', async () => {
    const body = createMockRevenueCatEvent('INITIAL_PURCHASE', {
      product_id: 'kortix_plus_monthly',
    });

    const result = await processRevenueCatWebhook(body);

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].data.tier).toBe('tier_2_20');
    // tier_grant ($20) + machine_bonus ($5)
    expect(grantCreditsCalls.length).toBe(2);
    expect(grantCreditsCalls[0][1]).toBe(20); // tier_2_20 = $20 monthly credits
    expect(grantCreditsCalls[1][1]).toBe(5);  // $5 machine bonus
    expect(result.event_type).toBe('INITIAL_PURCHASE');
  });

  test('duplicate RevenueCat event IDs are idempotent and do not grant twice', async () => {
    const seen = new Set<string>();
    mockRegistry.recordWebhookEvent = async (...args: any[]) => {
      const key = String(args[0]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };

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
    expect(grantCreditsCalls.length).toBe(2);
  });

  test('RENEWAL: resets expiring credits', async () => {
    // Default mock has tier from getCreditAccount, which has tier_6_50
    const body = createMockRevenueCatEvent('RENEWAL');

    await processRevenueCatWebhook(body);

    expect(resetExpiringCreditsCalls.length).toBe(1);
    expect(resetExpiringCreditsCalls[0][1]).toBe(50); // tier_6_50 = $50 monthly credits
  });

  test('CANCELLATION: sets cancelled timestamp', async () => {
    const body = createMockRevenueCatEvent('CANCELLATION', {
      expiration_at_ms: Date.now() + 86400000,
    });

    await processRevenueCatWebhook(body);

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.revenuecatCancelledAt).toBeDefined();
    expect(updateCreditAccountCalls[0].data.revenuecatCancelAtPeriodEnd).toBeDefined();
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

    expect(grantCreditsCalls.length).toBe(1);
    expect(grantCreditsCalls[0][1]).toBe(25);
    expect(grantCreditsCalls[0][4]).toBe(false);
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
    expect(grantCreditsCalls.length).toBe(0);
  });

  test('throws on missing event', async () => {
    try {
      await processRevenueCatWebhook({});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe('WebhookError');
    }
  });

  test('throws on missing app_user_id', async () => {
    try {
      await processRevenueCatWebhook({ event: { type: 'INITIAL_PURCHASE' } });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe('WebhookError');
    }
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
  test('skips update when subscription ID does not match account current sub', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_new_paid',
      });

    const staleSub = createMockStripeSubscription({
      id: 'sub_old_free',
      metadata: { account_id: 'acc_test_123', tier_key: 'free' },
    });
    const event = createMockStripeEvent('customer.subscription.updated', staleSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(0);
  });

  test('allows update when subscription ID matches account current sub', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_test_123',
      });

    const sub = createMockStripeSubscription({ id: 'sub_test_123' });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
  });

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

  test('reverts to free when deleted subscription ID matches account current sub', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_test_123',
      });

    const sub = createMockStripeSubscription({ id: 'sub_test_123' });
    const event = createMockStripeEvent('customer.subscription.deleted', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.tier).toBe('free');
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

  test('still skips stale sub when stored sub is alive (not orphaned)', async () => {
    // Account points at a LIVE sub — incoming different sub should still be skipped
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        stripeSubscriptionId: 'sub_live_existing',
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
        tier: 'tier_6_50',
      });

    const staleSub = createMockStripeSubscription({
      id: 'sub_old_free',
      metadata: { account_id: 'acc_test_123', tier_key: 'free' },
    });
    const event = createMockStripeEvent('customer.subscription.updated', staleSub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should NOT update — the stored sub is live, incoming is stale
    expect(updateCreditAccountCalls.length).toBe(0);
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

  test('reverts to free when no other active sub exists', async () => {
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

    // No other active subs
    mockRegistry.stripeClient.subscriptions.list = async () => ({ data: [] });

    await processStripeWebhook(JSON.stringify(event), 'sig');

    // Should revert to free
    const freeRevert = updateCreditAccountCalls.find((c: any) => c.data.tier === 'free');
    expect(freeRevert).toBeDefined();
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

  test('adding 4 seats grants 4 x $25 of allowance, not 4 x the $40 price', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat', tier: 'per_seat', seatCount: 1 });

    await syncSeats(perSeatSub(5));

    const seatGrant = grantCreditsCalls.find((c: any) => c[2] === 'seat_grant');
    expect(seatGrant).toBeDefined();
    expect(seatGrant[1]).toBe(100);
    expect(seatGrant[1]).not.toBe(160);
  });

  test('adding 1 seat grants $25, the included allowance for one seat', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat', tier: 'per_seat', seatCount: 2 });

    await syncSeats(perSeatSub(3));

    const seatGrant = grantCreditsCalls.find((c: any) => c[2] === 'seat_grant');
    expect(seatGrant[1]).toBe(25);
    expect(seatGrant[1]).not.toBe(40);
  });

  test('removing seats grants nothing', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat', tier: 'per_seat', seatCount: 6 });

    await syncSeats(perSeatSub(2));

    expect(grantCreditsCalls.filter((c: any) => c[2] === 'seat_grant').length).toBe(0);
  });

  test('the seat-grant idempotency key names the seat count reached AND the billing period', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat', tier: 'per_seat', seatCount: 1 });

    const sub = perSeatSub(3, { current_period_start: 1_700_000_000 });
    await syncSeats(sub);

    const seatGrant = grantCreditsCalls.find((c: any) => c[2] === 'seat_grant');
    expect(seatGrant[5]).toBe('sub_seats_1:seats:1700000000:3');
  });

  test('shrinking and regrowing to the same seat count inside one period reuses the key', async () => {
    // Seat removals never claw allowance back, so a team that goes 1→3, 3→2 and
    // then 2→3 within one billing period is already funded for 3 seats. Keying
    // on the destination count (not the `old->new` transition) makes the second
    // arrival dedupe instead of funding the same seat twice.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat', tier: 'per_seat', seatCount: 1 });
    await syncSeats(perSeatSub(3, { current_period_start: 1_700_000_000 }));
    const grown = grantCreditsCalls.find((c: any) => c[2] === 'seat_grant')[5];

    grantCreditsCalls.length = 0;
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat', tier: 'per_seat', seatCount: 2 });
    await syncSeats(perSeatSub(3, { current_period_start: 1_700_000_000 }));
    const regrown = grantCreditsCalls.find((c: any) => c[2] === 'seat_grant')[5];

    expect(regrown).toBe(grown);
  });

  test('the same seat count in a LATER period is a different key, so re-added seats get funded', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'per_seat', tier: 'per_seat', seatCount: 1 });

    await syncSeats(perSeatSub(3, { current_period_start: 1_700_000_000 }));
    const first = grantCreditsCalls.find((c: any) => c[2] === 'seat_grant')[5];

    grantCreditsCalls.length = 0;
    await syncSeats(perSeatSub(3, { current_period_start: 1_702_600_000 }));
    const second = grantCreditsCalls.find((c: any) => c[2] === 'seat_grant')[5];

    expect(second).not.toBe(first);
  });

  test('a recovering per-seat team is reset to its FULL seat allowance, not a flat $25', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        billingModel: 'per_seat',
        seatCount: 0,
        stripeSubscriptionId: null,
      });

    await syncSeats(perSeatSub(6));

    expect(resetExpiringCreditsCalls.length).toBe(1);
    expect(resetExpiringCreditsCalls[0][1]).toBe(150);
    expect(resetExpiringCreditsCalls[0][1]).not.toBe(25);
  });

  test('a recovery reset that already funded every seat does NOT also take the delta grant', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        billingModel: 'per_seat',
        seatCount: 0,
        stripeSubscriptionId: null,
      });

    await syncSeats(perSeatSub(6));

    expect(resetExpiringCreditsCalls[0][1]).toBe(150);
    expect(grantCreditsCalls.filter((c: any) => c[2] === 'seat_grant').length).toBe(0);
  });

  test('a brand-new per-seat team still gets seat tokens minted even though the delta grant is skipped', async () => {
    // Minting is not a money decision. It used to sit inside the credit-grant
    // block, so suppressing the redundant delta grant above would also have
    // stopped minting for every newly activated team — the exact case the mint
    // exists for.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'free',
        billingModel: null,
        seatCount: 0,
        stripeSubscriptionId: null,
      });

    await syncSeats(perSeatSub(6));

    expect(grantCreditsCalls.filter((c: any) => c[2] === 'seat_grant').length).toBe(0);
    expect(mintYoloTokensCalls).toEqual(['acc_test_123']);
  });

  test('a legacy tier recovery is still sized by the tier, not by seats', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ tier: 'free', stripeSubscriptionId: null, seatCount: 0 });

    const sub = createMockStripeSubscription({ id: 'sub_legacy_recover' });
    await syncSeats(sub);

    expect(resetExpiringCreditsCalls.length).toBe(1);
    expect(resetExpiringCreditsCalls[0][1]).toBe(50);
  });
});
