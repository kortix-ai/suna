import { beforeEach, describe, expect, mock, test } from 'bun:test';

const accounts = { __table: 'accounts', accountId: 'accountId' };
const accountMembers = { __table: 'accountMembers', accountId: 'accountId', userId: 'userId' };
// The IDENTITY table `account_members` became a view over. `mock.module`
// replaces `@kortix/db` WHOLESALE, so a missing name is a SyntaxError in every
// importer — it has to be declared even where this suite never reads it.
const accountMemberships = { __table: 'accountMemberships', userId: 'userId', accountId: 'accountId' };
const billingCustomers = { __table: 'billingCustomers', accountId: 'accountId', id: 'id', email: 'email', active: 'active', provider: 'provider' };
const creditAccounts = { __table: 'creditAccounts', accountId: 'accountId', tier: 'tier', stripeSubscriptionId: 'stripeSubscriptionId' };
// Transitively imported by accounts/core/{app,members}.ts (pulled in via the app
// graph). resolve-account never queries these — the symbols just have to exist
// so the static `@kortix/db` imports resolve.
const accountInvitations = { __table: 'accountInvitations', accountId: 'accountId', email: 'email', inviteId: 'inviteId', acceptedAt: 'acceptedAt', expiresAt: 'expiresAt' };
const accountGroups = { __table: 'accountGroups', accountId: 'accountId', groupId: 'groupId' };
const accountGroupMembers = { __table: 'accountGroupMembers', groupId: 'groupId', userId: 'userId' };
const projectMembers = { __table: 'projectMembers', projectId: 'projectId', userId: 'userId' };

const state = {
  membership: null as { accountId: string } | null,
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
        // resolveAccountId orders memberships by joinedAt to pick the
        // user's primary (earliest) account.
        orderBy: () => ({
          limit: async (count: number) => rowsForTable(table).slice(0, count),
        }),
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
  ne: (column: string, value: unknown) => ({ op: 'ne', column, value }),
  asc: (column: string) => ({ op: 'asc', column }),
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  or: (...parts: unknown[]) => ({ op: 'or', parts }),
  isNull: (column: string) => ({ op: 'isNull', column }),
  isNotNull: (column: string) => ({ op: 'isNotNull', column }),
  inArray: (column: string, values: unknown[]) => ({ op: 'inArray', column, values }),
  gte: (column: string, value: unknown) => ({ op: 'gte', column, value }),
  lte: (column: string, value: unknown) => ({ op: 'lte', column, value }),
  gt: (column: string, value: unknown) => ({ op: 'gt', column, value }),
  count: (column?: unknown) => ({ op: 'count', column }),
  desc: (column: string) => ({ op: 'desc', column }),
  sql: (...args: unknown[]) => ({ op: 'sql', args }),
}));

// `mock.module` replaces the module WHOLESALE, so every table this file's graph
// touches has to be declared — `role_assignments` and `iam_roles` because the
// account role is read from the canonical store now, `audit_events` because
// `assignRole` writes one.
mock.module('@kortix/db', () => ({
  accounts,
  accountMembers,
  accountMemberships,
  billingCustomers,
  creditAccounts,
  accountInvitations,
  accountGroups,
  accountGroupMembers,
  projectMembers,
  roleAssignments: {},
  iamRoles: {},
  iamRoleActions: {},
  auditEvents: {},
  serviceAccounts: {},
  accountTokens: {},
  objectPolicies: {},
  permissions: {},
}));

mock.module('../shared/db', () => ({ db: fakeDb }));

mock.module('../billing/repositories/customers', () => ({
  getCustomerByAccountId: async () => state.legacyCustomer,
  upsertCustomer: async (data: Record<string, unknown>) => {
    upsertCustomerCalls.push(data);
  },
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => null,
  upsertCreditAccount: async (accountId: string, data: Record<string, unknown>) => {
    upsertCreditAccountCalls.push({ accountId, data });
  },
  // The write-ownership chokepoint (account-write-owner.ts) imports this name;
  // a partial mock without it fails the whole import chain at module load.
  updateCreditAccount: async (accountId: string, data: Record<string, unknown>) => {
    upsertCreditAccountCalls.push({ accountId, data });
  },
}));

mock.module('../billing/services/credits', () => ({
  resetExpiringCredits: async (...args: any[]) => {
    resetExpiringCreditsCalls.push(args);
  },
  grantCredits: async () => undefined,
}));

mock.module('../billing/services/tiers', () => ({
  MACHINE_CREDIT_BONUS: 5,
  MINIMUM_CREDIT_FOR_RUN: 0.01,
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

const { resolveAccountId, resolveScopedAccountId } = await import('../shared/resolve-account');
const { runWithContext } = await import('../lib/request-context');
const { setImpersonationContext } = await import('../shared/impersonation');

beforeEach(() => {
  state.membership = null;
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

// ─── Act-as ──────────────────────────────────────────────────────────────────
// Account resolution is the funnel every account-scoped route goes through, so
// it is where the impersonated account has to win — a fall-through here would
// silently scope a support operator's writes to their OWN account.

const IMP_ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IMP_TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IMP_GRANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function actingAs<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext('GET', '/v1/projects', async () => {
    setImpersonationContext({
      grantId: IMP_GRANT,
      targetAccountId: IMP_TARGET,
      impersonatorUserId: IMP_ADMIN,
    });
    return fn();
  });
}

function fakeRequest(query?: string) {
  return {
    req: {
      query: (_key: string) => query,
      json: async () => ({}),
    },
    get: (key: string) => (key === 'userId' ? IMP_ADMIN : undefined),
  } as never;
}

describe('resolveAccountId under impersonation', () => {
  test('returns the target account and never the operator own membership', async () => {
    // The operator HAS a membership of their own. Without the act-as branch
    // this is exactly what would come back.
    state.membership = { accountId: 'acct_operator_own' };
    const accountId = await actingAs(() => resolveAccountId(IMP_ADMIN));
    expect(accountId).toBe(IMP_TARGET);
  });

  test('does not run the legacy Stripe recovery sync against the customer', async () => {
    state.membership = { accountId: 'acct_operator_own' };
    state.creditAccount = { tier: 'free', stripeSubscriptionId: null };
    state.legacyCustomer = { id: 'cus_x', email: 'x@example.com' };
    await actingAs(() => resolveAccountId(IMP_ADMIN));
    expect(stripeListCalls).toHaveLength(0);
    expect(upsertCreditAccountCalls).toHaveLength(0);
  });

  test('another user id is unaffected by the operator grant', async () => {
    state.membership = { accountId: 'acct_someone_else' };
    const accountId = await actingAs(() => resolveAccountId('some-other-user'));
    expect(accountId).toBe('acct_someone_else');
  });
});

describe('resolveScopedAccountId under impersonation', () => {
  test('no explicit account_id resolves to the target', async () => {
    state.membership = { accountId: 'acct_operator_own' };
    const accountId = await actingAs(() => resolveScopedAccountId(fakeRequest(), 'query'));
    expect(accountId).toBe(IMP_TARGET);
  });

  test('an explicit account_id matching the target is accepted', async () => {
    const accountId = await actingAs(() => resolveScopedAccountId(fakeRequest(IMP_TARGET), 'query'));
    expect(accountId).toBe(IMP_TARGET);
  });

  test('an explicit account_id for ANOTHER account is refused, not silently retargeted', async () => {
    state.membership = { accountId: 'acct_operator_own' };
    let status: number | undefined;
    let code: string | undefined;
    await actingAs(async () => {
      try {
        await resolveScopedAccountId(fakeRequest('acct_operator_own'), 'query');
      } catch (error) {
        const httpError = error as { status?: number; res?: Response };
        status = httpError.status;
        code = (await httpError.res!.clone().json()).code;
      }
    });
    expect(status).toBe(403);
    expect(code).toBe('impersonation_invalid');
  });
});
