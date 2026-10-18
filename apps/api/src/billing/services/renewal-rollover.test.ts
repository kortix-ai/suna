import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Production price catalog: the legacy prices below only exist there.
mock.module('../../config', () => ({
  config: new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_target, key) => {
      if (key === 'INTERNAL_KORTIX_ENV') return 'prod';
      if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_test';
      return undefined;
    },
  }),
}));

const CREDITS_PRICE = 'price_1UQEUsG6l1KZGqIrSUPCdtIO';
const PER_SEAT_PRICE = 'price_1TdyruG6l1KZGqIrMzPVmQSO';
const FREE_PRICE = 'price_1RIGvuG6l1KZGqIrw14abxeL';

let event: Record<string, any> = {};
let subscription: Record<string, any> = {};
let account: Record<string, any> | null = null;
let expiringNow = 0;
const resets: Array<{ amount: number; description: string; key: unknown }> = [];
const syncs: Array<Record<string, unknown>> = [];

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => subscription, update: async () => ({}) },
  }),
}));
mock.module('./webhook-concurrency', () => ({
  isWebhookEventProcessed: async () => false,
  recordWebhookEvent: async () => undefined,
  withAccountLock: async (_id: string, fn: () => Promise<unknown>) => fn(),
}));
mock.module('./account-write-owner', () => ({
  applyStripeSync: async (_id: string, patch: Record<string, unknown>) => {
    syncs.push(patch);
  },
}));
mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => account,
  updateCreditAccount: async () => undefined,
  upsertCreditAccount: async () => undefined,
}));
mock.module('../repositories/customers', () => ({
  getCustomerByStripeId: async () => null,
  upsertCustomer: async () => undefined,
}));
mock.module('../wallet', () => ({
  wallet: {
    reset: async (input: { amount: number; description: string; key: unknown }) => {
      resets.push(input);
    },
    grant: async () => ({ replayed: false }),
    balance: async () => ({ balance: expiringNow, expiring: expiringNow, nonExpiring: 0, daily: 0 }),
  },
}));
mock.module('./subscriptions', () => ({ cancelFreeSubscriptionForUpgrade: async () => undefined }));
mock.module('./refund-clawback', () => ({
  handleChargeRefunded: async () => undefined,
  handleDisputeClosed: async () => undefined,
  handleDisputeCreated: async () => undefined,
}));
mock.module('../repositories/transactions', () => ({
  updatePurchaseStatus: async () => undefined,
  getPurchaseByPaymentIntent: async () => null,
}));

const { processStripeWebhook } = await import('./webhooks');

function sub(price: string, quantity: number) {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    current_period_end: 2_000_000_000,
    metadata: { account_id: 'acct-1' },
    items: { data: [{ id: 'si_1', quantity, price: { id: price, unit_amount: 1, recurring: { interval: 'month' } } }] },
  };
}

function renewal() {
  return {
    id: 'evt_renew',
    type: 'invoice.paid',
    data: { object: { id: 'in_cycle', subscription: 'sub_1', billing_reason: 'subscription_cycle', period_start: 1_897_400_000, period_end: 1_900_000_000, amount_paid: 10_000 } },
  };
}

beforeEach(() => {
  event = renewal();
  resets.length = 0;
  syncs.length = 0;
  expiringNow = 0;
});

describe('monthly renewal on the credits plan', () => {
  test('grants the subscription amount plus last month’s unused credits', async () => {
    subscription = sub(CREDITS_PRICE, 10_000);
    account = { accountId: 'acct-1', tier: 'credits', planMonthlyUsd: '100', planType: 'monthly' };
    expiringNow = 37.5;

    await processStripeWebhook('{}', 'sig');

    expect(resets).toHaveLength(1);
    expect(resets[0].amount).toBe(137.5);
    expect(resets[0].description).toBe('Monthly renewal: 10000 credits + 3750 rolled over');
    expect(resets[0].key).toEqual({ event: 'in_cycle' });
    expect(syncs.at(-1)).toMatchObject({ planMonthlyUsd: '100', lastProcessedInvoiceId: 'in_cycle' });
  });

  test('the carry is capped at last month’s allowance, so it never compounds', async () => {
    subscription = sub(CREDITS_PRICE, 10_000);
    account = { accountId: 'acct-1', tier: 'credits', planMonthlyUsd: '100', planType: 'monthly' };
    expiringNow = 180; // last month's 100 + a carried 80, none of it spent

    await processStripeWebhook('{}', 'sig');

    expect(resets[0].amount).toBe(200);
  });

  test('a cut takes effect at renewal: the new quantity is granted, the carry uses the old amount', async () => {
    subscription = sub(CREDITS_PRICE, 2_000);
    account = { accountId: 'acct-1', tier: 'credits', planMonthlyUsd: '100', planType: 'monthly' };
    expiringNow = 60;

    await processStripeWebhook('{}', 'sig');

    expect(resets[0].amount).toBe(80);
    expect(syncs.at(-1)).toMatchObject({ planMonthlyUsd: '20', scheduledMonthlyUsd: null, scheduledTierChangeDate: null });
  });

  test('a legacy per-seat subscription renews as credits: $40 a seat, not $25', async () => {
    subscription = sub(PER_SEAT_PRICE, 6);
    account = { accountId: 'acct-1', tier: 'per_seat', seatCount: 6, planType: 'monthly' };

    await processStripeWebhook('{}', 'sig');

    expect(resets[0].amount).toBe(240);
    expect(syncs.at(-1)).toMatchObject({ planMonthlyUsd: '240' });
  });

  test('a comped account on a $0 price keeps its plan amount', async () => {
    subscription = sub('price_1RILb4G6l1KZGqIrK4QLrx9i', 1);
    subscription.items.data[0].price.unit_amount = 0;
    account = { accountId: 'acct-1', tier: 'tier_2_20', planType: 'monthly' };

    await processStripeWebhook('{}', 'sig');

    expect(resets[0].amount).toBe(20);
  });

  test('the free plan resets to its $5 with no carry', async () => {
    subscription = sub(FREE_PRICE, 1);
    account = { accountId: 'acct-1', tier: 'free', planType: 'monthly' };
    expiringNow = 1.5;

    await processStripeWebhook('{}', 'sig');

    expect(resets[0].amount).toBe(5);
    expect(resets[0].description).toBe('Monthly renewal: 500 credits');
  });

  test('the first renewal after activation is granted (Stripe dates a cycle invoice by the period that ended)', async () => {
    // Activation recorded the first period's start; the renewal invoice's
    // period_start is that same instant, its period_end the new period's start.
    subscription = sub(CREDITS_PRICE, 10_000);
    account = { accountId: 'acct-1', tier: 'credits', planMonthlyUsd: '100', lastRenewalPeriodStart: 1_897_400_000 };

    await processStripeWebhook('{}', 'sig');

    expect(resets).toHaveLength(1);
    expect(syncs.at(-1)).toMatchObject({ lastRenewalPeriodStart: 1_900_000_000 });
  });

  test('a period already renewed is skipped', async () => {
    subscription = sub(CREDITS_PRICE, 10_000);
    account = { accountId: 'acct-1', tier: 'credits', planMonthlyUsd: '100', lastRenewalPeriodStart: 1_900_000_000 };

    await processStripeWebhook('{}', 'sig');

    expect(resets).toHaveLength(0);
  });
});
