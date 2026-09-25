import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GrantInput } from '../wallet';

// Production price catalog: the legacy tier prices below only exist there.
mock.module('../../config', () => ({
  config: new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_target, key) => (key === 'INTERNAL_KORTIX_ENV' ? 'prod' : undefined),
  }),
}));

const TIER_6_50_MONTHLY = 'price_1RILb4G6l1KZGqIr5q0sybWn';
const TIER_12_100_MONTHLY = 'price_1RILb4G6l1KZGqIr5Y20ZLHm';

let account: Record<string, unknown> | null = null;
let subscriptionUpdateResult: Record<string, unknown> = {};
let seatItemQuantity = 1;
let activeMembers = 1;
const stripeUpdates: Array<{ id: string; params: Record<string, any> }> = [];
const itemUpdates: Array<{ id: string; params: Record<string, any> }> = [];
const tierWrites: Array<Record<string, unknown>> = [];
const grants: GrantInput[] = [];

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        status: 'active',
        customer: 'cus_1',
        schedule: null,
        items: { data: [{ id: 'si_plan', price: { id: TIER_6_50_MONTHLY } }] },
        metadata: { account_id: 'acct-1', tier_key: 'tier_6_50', plan_key: 'tier_6_50' },
      }),
      update: async (id: string, params: Record<string, any>) => {
        stripeUpdates.push({ id, params });
        return { id, ...subscriptionUpdateResult };
      },
    },
    subscriptionItems: {
      retrieve: async (id: string) => ({ id, quantity: seatItemQuantity }),
      update: async (id: string, params: Record<string, any>) => {
        itemUpdates.push({ id, params });
        return { id, quantity: params.quantity };
      },
    },
    subscriptionSchedules: { release: async () => ({}) },
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
    if ('tier' in patch) tierWrites.push(patch);
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

mock.module('../../shared/platform-roles', () => ({ isPlatformAdmin: async () => false }));

mock.module('../../shared/db', () => ({
  db: {
    execute: async () => [{ n: activeMembers }],
  },
}));

mock.module('./yolo-tokens', () => ({
  mintYoloTokenForMember: async () => undefined,
  revokeYoloTokenForMember: async () => undefined,
}));
mock.module('../repositories/yolo-tokens', () => ({ getActiveYoloTokenRow: async () => null }));

const { createInlineCheckout } = await import('./subscriptions');
const { syncSeatQuantity } = await import('./seat-management');

beforeEach(() => {
  account = {
    accountId: 'acct-1',
    tier: 'tier_6_50',
    billingModel: 'legacy',
    stripeSubscriptionId: 'sub_plan',
    autoTopupCustomized: true,
  };
  subscriptionUpdateResult = {};
  stripeUpdates.length = 0;
  itemUpdates.length = 0;
  tierWrites.length = 0;
  grants.length = 0;
  seatItemQuantity = 1;
  activeMembers = 1;
});

describe('a plan upgrade activates only after its proration invoice is paid', () => {
  const upgrade = () =>
    createInlineCheckout({ accountId: 'acct-1', email: 'owner@example.test', tierKey: 'tier_12_100', billingPeriod: 'monthly' });

  test('Stripe is asked to charge now and apply the change only if the charge succeeds', async () => {
    subscriptionUpdateResult = { pending_update: { expires_at: 1 }, latest_invoice: { id: 'in_1', status: 'open', payment_intent: null } };
    await upgrade();

    expect(stripeUpdates).toHaveLength(1);
    expect(stripeUpdates[0].params.proration_behavior).toBe('always_invoice');
    expect(stripeUpdates[0].params.payment_behavior).toBe('pending_if_incomplete');
    expect(stripeUpdates[0].params.items).toEqual([{ id: 'si_plan', price: TIER_12_100_MONTHLY }]);
  });

  test('a declined or unauthenticated payment (pending_update) writes no tier and grants nothing', async () => {
    subscriptionUpdateResult = {
      pending_update: { expires_at: 1 },
      latest_invoice: { id: 'in_declined', status: 'open', payment_intent: { client_secret: 'pi_secret_test' } },
    };

    const result = (await upgrade()) as Record<string, unknown>;

    expect(result.status).toBe('payment_pending');
    expect((result as any).client_secret).toBe('pi_secret_test');
    expect(tierWrites).toHaveLength(0);
    expect(grants).toHaveLength(0);
  });

  test('a paid proration invoice writes the target tier and grants the prorated allowance once, keyed on the invoice', async () => {
    subscriptionUpdateResult = {
      pending_update: null,
      latest_invoice: {
        id: 'in_paid',
        status: 'paid',
        lines: {
          has_more: false,
          data: [
            { amount: -2500, proration: true, price: { id: TIER_6_50_MONTHLY } },
            { amount: 5000, proration: true, price: { id: TIER_12_100_MONTHLY } },
          ],
        },
      },
    };

    const result = (await upgrade()) as Record<string, unknown>;

    expect(result.status).toBe('upgraded');
    expect(tierWrites.map((w) => w.tier)).toEqual(['tier_12_100']);
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(25);
    expect(grants[0].kind).toBe('tier_grant');
    expect(grants[0].key).toEqual({ event: 'proration_grant:in_paid' });
  });

  test('a per-seat account cannot swap its seat price for a plan price', async () => {
    account = { ...account, tier: 'per_seat', billingModel: 'per_seat' };

    await expect(upgrade()).rejects.toThrow('seat management');
    expect(stripeUpdates).toHaveLength(0);
  });
});

describe('per-seat quantity sync bills added seats now and never refunds removed seats', () => {
  beforeEach(() => {
    account = {
      accountId: 'acct-1',
      tier: 'per_seat',
      billingModel: 'per_seat',
      stripeSubscriptionId: 'sub_seats',
      seatSubscriptionItemId: 'si_seats',
      autoTopupCustomized: true,
    };
  });

  test('adding members invoices the prorated seat charge immediately', async () => {
    seatItemQuantity = 1;
    activeMembers = 3;

    await syncSeatQuantity('acct-1');

    expect(itemUpdates).toEqual([{ id: 'si_seats', params: { quantity: 3, proration_behavior: 'always_invoice' } }]);
  });

  test('removing members lowers the quantity with no proration credit', async () => {
    seatItemQuantity = 4;
    activeMembers = 2;

    await syncSeatQuantity('acct-1');

    expect(itemUpdates).toEqual([{ id: 'si_seats', params: { quantity: 2, proration_behavior: 'none' } }]);
  });

  test('an unchanged member count sends no update', async () => {
    seatItemQuantity = 2;
    activeMembers = 2;

    await syncSeatQuantity('acct-1');

    expect(itemUpdates).toHaveLength(0);
  });
});
