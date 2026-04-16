import { beforeEach, describe, expect, mock, test } from 'bun:test';

const accounts = { __table: 'accounts', accountId: 'accountId' };
const accountMembers = { __table: 'accountMembers', accountId: 'accountId', userId: 'userId' };
const accountUser = { __table: 'accountUser', accountId: 'accountId', userId: 'userId' };
const billingCustomers = { __table: 'billingCustomers', accountId: 'accountId', id: 'id', email: 'email', active: 'active', provider: 'provider' };
const creditAccounts = { __table: 'creditAccounts', accountId: 'accountId', tier: 'tier', stripeSubscriptionId: 'stripeSubscriptionId' };

const state = {
  membership: null as { accountId: string } | null,
  legacyMembership: null as { accountId: string } | null,
  creditAccount: null as { tier?: string | null; stripeSubscriptionId?: string | null } | null,
  legacyCustomer: null as { id?: string | null; email?: string | null } | null,
  customerSearchResults: [] as Array<{ id: string }>,
  subscriptionResults: {} as Record<string, any[]>,
};

const insertCalls: Array<{ table: string; data: Record<string, unknown> }> = [];
const upsertCustomerCalls: Array<Record<string, unknown>> = [];
const upsertCreditAccountCalls: Array<{ accountId: string; data: Record<string, unknown> }> = [];
const resetExpiringCreditsCalls: Array<any[]> = [];
const stripeListCalls: string[] = [];

function rowsForTable(table: { __table: string }) {
  switch (table.__table) {
    case 'accountMembers':
      return state.membership ? [state.membership] : [];
    case 'accountUser':
      return state.legacyMembership ? [state.legacyMembership] : [];
    case 'creditAccounts':
      return state.creditAccount ? [state.creditAccount] : [];
    default:
      return [];
  }
}

const fakeDb = {
  select: () => ({
    from: (table: { __table: string }) => ({
      where: () => ({
        limit: async (count: number) => rowsForTable(table).slice(0, count),
      }),
    }),
  }),
  insert: (table: { __table: string }) => ({
    values: (data: Record<string, unknown>) => {
      insertCalls.push({ table: table.__table, data });
      return {
        onConflictDoNothing: async () => undefined,
      };
    },
  }),
};

mock.module('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ column, value }),
}));

mock.module('@kortix/db', () => ({
  accounts,
  accountMembers,
  accountUser,
  billingCustomers,
  creditAccounts,
}));

mock.module('../shared/db', () => ({ db: fakeDb }));

mock.module('../billing/repositories/customers', () => ({
  getCustomerByAccountId: async () => state.legacyCustomer,
  upsertCustomer: async (data: Record<string, unknown>) => {
    upsertCustomerCalls.push(data);
  },
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  upsertCreditAccount: async (accountId: string, data: Record<string, unknown>) => {
    upsertCreditAccountCalls.push({ accountId, data });
  },
}));

mock.module('../billing/services/credits', () => ({
  resetExpiringCredits: async (...args: any[]) => {
    resetExpiringCreditsCalls.push(args);
  },
}));

mock.module('../billing/services/tiers', () => ({
  MACHINE_CREDIT_BONUS: 5,
  getTier: (tierName: string) => ({
    name: tierName,
    monthlyCredits: tierName === 'tier_2_20' ? 20 : tierName === 'tier_6_50' ? 50 : 0,
  }),
  getTierByPriceId: (priceId: string) => {
    if (priceId === 'price_paid_yearly') return { name: 'tier_2_20' };
    if (priceId === 'price_paid_monthly') return { name: 'tier_6_50' };
    if (priceId === 'price_free') return { name: 'free' };
    return null;
  },
  getBillingPeriodByPriceId: (priceId: string) => {
    if (priceId === 'price_paid_yearly') return 'yearly';
    return 'monthly';
  },
}));

mock.module('../shared/stripe', () => ({
  getStripe: () => ({
    customers: {
      retrieve: async (id: string) => ({ id, deleted: false }),
      search: async () => ({ data: state.customerSearchResults }),
    },
    subscriptions: {
      update: async () => null,
      list: async ({ customer }: { customer: string }) => {
        stripeListCalls.push(customer);
        return { data: state.subscriptionResults[customer] ?? [] };
      },
    },
  }),
}));

const { resolveAccountId } = await import('../shared/resolve-account');

beforeEach(() => {
  state.membership = null;
  state.legacyMembership = null;
  state.creditAccount = null;
  state.legacyCustomer = null;
  state.customerSearchResults = [];
  state.subscriptionResults = {};
  insertCalls.length = 0;
  upsertCustomerCalls.length = 0;
  upsertCreditAccountCalls.length = 0;
  resetExpiringCreditsCalls.length = 0;
  stripeListCalls.length = 0;
});

describe('resolveAccountId legacy billing sync', () => {
  test('syncs a paid legacy Stripe subscription for an already-migrated membership', async () => {
    state.membership = { accountId: 'acct_paid_123' };
    state.legacyCustomer = { id: 'cus_legacy_123', email: 'paid@example.com' };
    state.subscriptionResults = {
      cus_legacy_123: [
        {
          id: 'sub_paid_123',
          status: 'active',
          items: {
            data: [
              {
                price: {
                  id: 'price_paid_yearly',
                  recurring: { interval: 'year' },
                },
              },
            ],
          },
        },
      ],
    };

    const accountId = await resolveAccountId('user_paid_123');

    expect(accountId).toBe('acct_paid_123');
    expect(stripeListCalls).toEqual(['cus_legacy_123']);
    expect(upsertCreditAccountCalls).toHaveLength(1);
    expect(upsertCreditAccountCalls[0]).toEqual({
      accountId: 'acct_paid_123',
      data: {
        billingCycleAnchor: undefined,
        commitmentEndDate: null,
        commitmentType: null,
        tier: 'tier_2_20',
        provider: 'stripe',
        stripeSubscriptionId: 'sub_paid_123',
        stripeSubscriptionStatus: 'active',
        planType: 'yearly',
      },
    });
    expect(upsertCustomerCalls).toContainEqual({
      accountId: 'acct_paid_123',
      id: 'cus_legacy_123',
      email: 'paid@example.com',
      active: true,
      provider: 'stripe',
    });
    expect(resetExpiringCreditsCalls).toContainEqual([
      'acct_paid_123',
      20,
      'Recovered legacy Stripe subscription: 20 credits',
      'legacy_sync:sub_paid_123',
    ]);
  });

  test('skips Stripe sync when the account already has a Stripe subscription row', async () => {
    state.membership = { accountId: 'acct_existing_123' };
    state.creditAccount = { tier: 'tier_6_50', stripeSubscriptionId: 'sub_existing_123' };
    state.legacyCustomer = { id: 'cus_existing_123', email: 'existing@example.com' };

    const accountId = await resolveAccountId('user_existing_123');

    expect(accountId).toBe('acct_existing_123');
    expect(stripeListCalls).toHaveLength(0);
    expect(upsertCreditAccountCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });
});
