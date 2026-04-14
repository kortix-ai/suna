import { describe, test, expect, beforeEach } from 'bun:test';
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
    expect(result.received).toBe(true);
    expect((result as any).event_type).toBe('some.unknown.event');
  });

  test('returns { received: true } for unhandled events', async () => {
    const event = createMockStripeEvent('charge.refunded', {});
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    const result = await processStripeWebhook(JSON.stringify(event), 'sig');
    expect(result.received).toBe(true);
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
        data: [{ id: 'si_123', price: { id: 'price_1RIGvuG6l1KZGqIrvjlz5p5V' } }],
      },
    });
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    mockRegistry.stripeClient.webhooks.constructEvent = () => event;

    await processStripeWebhook(JSON.stringify(event), 'sig');

    expect(updateCreditAccountCalls[0].data.tier).toBe('tier_6_50');
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
