import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GrantInput } from '../wallet';

// Production price catalog: the legacy prices below only exist there.
mock.module('../../config', () => ({
  config: new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_target, key) => (key === 'INTERNAL_KORTIX_ENV' ? 'prod' : undefined),
  }),
}));

const CREDITS_PRICE = 'price_1UQEUsG6l1KZGqIrSUPCdtIO';
const PER_SEAT_PRICE = 'price_1TdyruG6l1KZGqIrMzPVmQSO';
const FREE_PRICE = 'price_1RIGvuG6l1KZGqIrw14abxeL';

let account: Record<string, unknown> | null = null;
let liveSubscription: Record<string, any> | null = null;
let updateResult: Record<string, unknown> = {};
let upcomingLines: Array<{ amount: number; proration: boolean }> = [];
const upcomingCalls: Array<Record<string, any>> = [];
const checkouts: Array<Record<string, any>> = [];
const checkoutOptions: unknown[] = [];
const updates: Array<{ id: string; params: Record<string, any> }> = [];
const syncs: Array<Record<string, unknown>> = [];
const grants: GrantInput[] = [];

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async () => liveSubscription,
      update: async (id: string, params: Record<string, any>) => {
        updates.push({ id, params });
        return { id, ...updateResult };
      },
    },
    invoices: {
      retrieveUpcoming: async (params: Record<string, any>) => {
        upcomingCalls.push(params);
        return { lines: { data: upcomingLines } };
      },
    },
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>, options: unknown) => {
          checkouts.push(params);
          checkoutOptions.push(options);
          return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' };
        },
      },
    },
    customers: { retrieve: async (id: string) => ({ id }) },
  }),
}));

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => account,
  updateCreditAccount: async () => undefined,
  upsertCreditAccount: async () => undefined,
}));

mock.module('../repositories/customers', () => ({
  getCustomerByAccountId: async () => ({ id: 'cus_1', accountId: 'acct-1' }),
  getCustomerByStripeId: async () => ({ id: 'cus_1', accountId: 'acct-1' }),
  upsertCustomer: async () => undefined,
  deleteCustomerByStripeId: async () => undefined,
}));

mock.module('./account-write-owner', () => ({
  applyStripeSync: async (_accountId: string, patch: Record<string, unknown>) => {
    syncs.push(patch);
  },
}));

mock.module('../wallet', () => ({
  wallet: {
    grant: async (input: GrantInput) => {
      grants.push(input);
      return { replayed: false, ledgerId: null };
    },
  },
}));

const { setPlan, previewPlan, parseMonthlyUsd } = await import('./subscriptions');

const base = { accountId: 'acct-1', email: 'owner@example.com', successUrl: 'https://s', cancelUrl: 'https://c' };

function sub(items: Array<{ price: string; quantity: number }>, status = 'active', id = 'sub_live') {
  return {
    id,
    status,
    customer: 'cus_1',
    current_period_end: PERIOD_END,
    metadata: { account_id: 'acct-1' },
    items: { data: items.map((it, i) => ({ id: `si_${i}`, quantity: it.quantity, price: { id: it.price, unit_amount: 1, recurring: { interval: 'month' } } })) },
  };
}

const PERIOD_END = Date.UTC(2026, 10, 14) / 1000;
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();

function paidInvoice(netCents: number) {
  return {
    id: 'in_raise',
    status: 'paid',
    amount_paid: netCents,
    lines: { data: [{ amount: netCents, proration: true, price: { id: CREDITS_PRICE } }], has_more: false },
  };
}

beforeEach(() => {
  account = { accountId: 'acct-1', tier: 'free', stripeSubscriptionId: 'sub_free' };
  liveSubscription = sub([{ price: FREE_PRICE, quantity: 1 }], 'active', 'sub_free');
  updateResult = {};
  checkouts.length = 0;
  checkoutOptions.length = 0;
  updates.length = 0;
  syncs.length = 0;
  grants.length = 0;
  upcomingLines = [];
  upcomingCalls.length = 0;
});

describe('parseMonthlyUsd', () => {
  test('accepts whole dollars from 50 to 10,000', () => {
    expect(parseMonthlyUsd(50)).toBe(50);
    expect(parseMonthlyUsd('100')).toBe(100);
    expect(parseMonthlyUsd(10_000)).toBe(10_000);
  });

  for (const bad of [20, 49, 10_001, 75.5, 0, -50, 'abc', null, undefined]) {
    test(`rejects ${String(bad)} with 400`, () => {
      expect(() => parseMonthlyUsd(bad)).toThrow(/whole number from 50 to 10000/);
    });
  }
});

describe('setPlan', () => {
  test('a free account goes to hosted Checkout with credits × quantity and the free sub as previous', async () => {
    const result = await setPlan({ ...base, monthlyUsd: 100 });

    expect(result).toEqual({ status: 'checkout_created', checkout_url: 'https://checkout.stripe.test/cs_1', monthly_usd: 100 });
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].mode).toBe('subscription');
    expect(checkouts[0].wallet_options).toEqual({ link: { display: 'never' } });
    expect(checkoutOptions[0]).toEqual({ apiVersion: '2025-04-30.basil' });
    expect(checkouts[0].line_items).toEqual([{ price: CREDITS_PRICE, quantity: 10_000 }]);
    expect(checkouts[0].subscription_data.metadata).toMatchObject({ plan_key: 'credits', previous_subscription_id: 'sub_free' });
    expect(updates).toHaveLength(0);
  });

  test('a raise on the credits price charges now, applies only if paid, and grants the net amount', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }]);
    updateResult = { latest_invoice: paidInvoice(4_000) };

    const result = await setPlan({ ...base, monthlyUsd: 200 });

    expect(result).toEqual({ status: 'updated', change: 'raised', monthly_usd: 200, charged_usd: 40, credits_added: 4_000 });
    expect(updates[0].params.items).toEqual([{ id: 'si_0', quantity: 20_000 }]);
    expect(updates[0].params.proration_behavior).toBe('always_invoice');
    expect(updates[0].params.payment_behavior).toBe('pending_if_incomplete');
    expect(syncs).toContainEqual({ tier: 'credits', planMonthlyUsd: '200', scheduledMonthlyUsd: null, scheduledTierChangeDate: null });
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(40);
    expect(grants[0].key).toEqual({ event: 'proration_grant:in_raise' });
  });

  test('a raise whose payment is pending writes nothing and grants nothing', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }]);
    updateResult = { pending_update: { expires_at: 1 }, latest_invoice: { id: 'in_x', status: 'open', payment_intent: { client_secret: 'pi_secret' } } };

    const result = await setPlan({ ...base, monthlyUsd: 500 });

    expect(result).toEqual({ status: 'payment_pending', monthly_usd: 500, client_secret: 'pi_secret' });
    expect(syncs).toHaveLength(0);
    expect(grants).toHaveLength(0);
  });

  test('a cut is scheduled for the renewal: no charge, no grant, this period keeps its amount', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live', planMonthlyUsd: '500' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 50_000 }]);

    const result = await setPlan({ ...base, monthlyUsd: 100 });

    expect(result).toEqual({ status: 'updated', change: 'scheduled', monthly_usd: 100, effective_at: PERIOD_END_ISO });
    expect(updates[0].params.items).toEqual([{ id: 'si_0', quantity: 10_000 }]);
    expect(updates[0].params.proration_behavior).toBe('none');
    expect(updates[0].params.payment_behavior).toBeUndefined();
    expect(syncs).toContainEqual({ tier: 'credits', planMonthlyUsd: '500', scheduledMonthlyUsd: '100', scheduledTierChangeDate: PERIOD_END_ISO });
    expect(grants).toHaveLength(0);
  });

  test('choosing the amount in effect again cancels a scheduled cut', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live', planMonthlyUsd: '500', scheduledMonthlyUsd: '100' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }]);

    const result = await setPlan({ ...base, monthlyUsd: 500 });

    expect(result).toEqual({ status: 'updated', change: 'kept', monthly_usd: 500 });
    expect(updates[0].params.items).toEqual([{ id: 'si_0', quantity: 50_000 }]);
    expect(updates[0].params.proration_behavior).toBe('none');
    expect(syncs).toContainEqual({ tier: 'credits', planMonthlyUsd: '500', scheduledMonthlyUsd: null, scheduledTierChangeDate: null });
  });

  test('a raise after a scheduled cut restores the amount in effect first, then charges from it', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live', planMonthlyUsd: '500', scheduledMonthlyUsd: '100' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }]);
    updateResult = { latest_invoice: paidInvoice(25_000) };

    await setPlan({ ...base, monthlyUsd: 1_000 });

    expect(updates.map((u) => [u.params.items[0].quantity, u.params.proration_behavior])).toEqual([
      [50_000, 'none'],
      [100_000, 'always_invoice'],
    ]);
    expect(syncs).toContainEqual({ tier: 'credits', planMonthlyUsd: '1000', scheduledMonthlyUsd: null, scheduledTierChangeDate: null });
  });

  test('the same amount is a no-op', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }]);

    expect(await setPlan({ ...base, monthlyUsd: 100 })).toEqual({ status: 'unchanged', change: 'none', monthly_usd: 100 });
    expect(updates).toHaveLength(0);
  });

  test('a per-seat subscription swaps its seat item for the credits price, prorated', async () => {
    account = { accountId: 'acct-1', tier: 'per_seat', stripeSubscriptionId: 'sub_live' };
    liveSubscription = sub([{ price: PER_SEAT_PRICE, quantity: 6 }]);
    updateResult = { latest_invoice: paidInvoice(0) };

    await setPlan({ ...base, monthlyUsd: 240 });

    expect(updates[0].params.items).toEqual([{ id: 'si_0', deleted: true }, { price: CREDITS_PRICE, quantity: 24_000 }]);
    expect(updates[0].params.proration_behavior).toBe('always_invoice');
    expect(updates[0].params.metadata).toMatchObject({ plan_key: 'credits', tier_key: 'credits' });
  });

  test('a yearly commitment that has not ended refuses the change', async () => {
    account = {
      accountId: 'acct-1',
      tier: 'tier_25_200',
      stripeSubscriptionId: 'sub_live',
      commitmentType: 'yearly_commitment',
      commitmentEndDate: new Date(Date.now() + 86_400_000).toISOString(),
    };
    liveSubscription = sub([{ price: 'price_1RqtrUG6l1KZGqIrEb8hLsk3', quantity: 1 }]);

    await expect(setPlan({ ...base, monthlyUsd: 500 })).rejects.toThrow(/yearly commitment/);
    expect(updates).toHaveLength(0);
  });

  test('a canceled paid subscription starts a new Checkout instead of changing a dead one', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }], 'canceled');

    const result = await setPlan({ ...base, monthlyUsd: 100 });

    expect(result.status).toBe('checkout_created');
    expect(updates).toHaveLength(0);
    expect(checkouts[0].subscription_data.metadata.previous_subscription_id).toBeUndefined();
  });
});

describe('previewPlan', () => {
  test('a free account previews Checkout: the first month is due now', async () => {
    expect(await previewPlan({ accountId: 'acct-1', monthlyUsd: 100 })).toEqual({
      change: 'checkout', monthly_usd: 100, current_monthly_usd: null, due_now_usd: 100, credits_now: 10_000, effective_at: null,
    });
  });

  test('a raise previews the prorated charge and the same credits the grant adds', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live', planMonthlyUsd: '100' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }]);
    upcomingLines = [{ amount: -5_000, proration: true }, { amount: 10_000, proration: true }, { amount: 20_000, proration: false }];

    expect(await previewPlan({ accountId: 'acct-1', monthlyUsd: 200 })).toEqual({
      change: 'raised', monthly_usd: 200, current_monthly_usd: 100, due_now_usd: 50, credits_now: 5_000, effective_at: null,
    });
    expect(upcomingCalls[0].subscription_items).toEqual([{ id: 'si_0', quantity: 20_000 }]);
    expect(upcomingCalls[0].subscription_proration_behavior).toBe('always_invoice');
    expect(updates).toHaveLength(0);
  });

  test('a raise over a scheduled cut is priced from the amount in effect', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live', planMonthlyUsd: '500', scheduledMonthlyUsd: '100' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 10_000 }]);
    // Stripe prices 100 → 1000 (+900); setPlan raises 500 → 1000 (+500).
    upcomingLines = [{ amount: 45_000, proration: true }];

    const preview = await previewPlan({ accountId: 'acct-1', monthlyUsd: 1_000 });
    expect([preview.change, preview.due_now_usd, preview.credits_now]).toEqual(['raised', 250, 25_000]);
  });

  test('a cut previews the renewal date and nothing due now', async () => {
    account = { accountId: 'acct-1', tier: 'credits', stripeSubscriptionId: 'sub_live', planMonthlyUsd: '500' };
    liveSubscription = sub([{ price: CREDITS_PRICE, quantity: 50_000 }]);

    expect(await previewPlan({ accountId: 'acct-1', monthlyUsd: 100 })).toEqual({
      change: 'scheduled', monthly_usd: 100, current_monthly_usd: 500, due_now_usd: 0, credits_now: 0, effective_at: PERIOD_END_ISO,
    });
    expect(upcomingCalls).toHaveLength(0);
  });
});
