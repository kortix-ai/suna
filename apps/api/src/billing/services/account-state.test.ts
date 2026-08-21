// buildMinimalAccountState used to fetch the identical credit_accounts row 4
// separate times (directly, then again inside getCreditSummary /
// getAccountEntitlements / getAutoTopupSettings) across ~10 fully sequential
// awaits. The fix: fetch the row once and pass it down, and run the
// independent lookups concurrently via Promise.all. This file asserts both
// halves of that fix — single fetch, real concurrency — plus that the
// response shape is unchanged. Mirrors the mock.module + dynamic import
// pattern in ./billing-gate.test.ts.
import { describe, expect, mock, test } from 'bun:test';
import { sandboxes } from '@kortix/db';
import { effectiveTierForLimits } from '../../shared/account-limits';
import { getTier } from './tiers';
import * as realUsageBreakdown from './usage-breakdown';

let getCreditAccountCalls = 0;
let account: Record<string, unknown> | null = null;

let inFlight = 0;
let maxInFlight = 0;

async function trackedDelay<T>(value: T, ms = 15): Promise<T> {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((resolve) => setTimeout(resolve, ms));
  inFlight -= 1;
  return value;
}

mock.module('../../config', () => ({
  config: {
    ENTERPRISE_LICENSE_AVAILABLE: false,
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    INTERNAL_KORTIX_ENV: 'dev',
  },
}));

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async (_accountId: string) => {
    getCreditAccountCalls += 1;
    return account;
  },
  getCreditBalance: async (_accountId: string) => account,
  updateCreditAccount: async () => undefined,
  getSubscriptionInfo: async (_accountId: string) => account,
}));

mock.module('./free-tier', () => ({
  initializeFreeTierAccount: async () => undefined,
}));

// ./credits and ./auto-topup are deliberately NOT mocked: they are two of the
// four call sites the dedupe fix threads `prefetchedAccount` through, so
// mocking them would make this suite pass even if they regressed to an
// unconditional getCreditAccount(). They reach getCreditAccount only via the
// mocked ../repositories/credit-accounts, so the real modules run here.

mock.module('./seat-management', () => ({
  countActiveMembers: async (_accountId: string) => trackedDelay(3),
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure
// lands in whatever file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
mock.module('./usage-breakdown', () => ({
  ...realUsageBreakdown,
  getUsageBreakdownThisPeriod: async (_accountId: string) => trackedDelay(null),
}));

mock.module('../../shared/platform-roles', () => ({
  isPlatformAdmin: async (_accountId: string) => trackedDelay(false),
}));

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = table === sandboxes ? [] : [{ activeCount: 0 }];
          const resultPromise = trackedDelay(rows);
          return {
            limit: async () => resultPromise,
            then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
              resultPromise.then(resolve, reject),
          };
        },
      }),
    }),
  }, auditDb: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = table === sandboxes ? [] : [{ activeCount: 0 }];
          const resultPromise = trackedDelay(rows);
          return {
            limit: async () => resultPromise,
            then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
              resultPromise.then(resolve, reject),
          };
        },
      }),
    }),
  },
}));

const { buildMinimalAccountState } = await import('./account-state');

function creditAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    tier: 'free',
    billingModel: 'legacy',
    balance: '10.00',
    dailyCreditsBalance: '1.00',
    expiringCredits: '5.00',
    nonExpiringCredits: '4.00',
    autoTopupEnabled: false,
    autoTopupThreshold: null,
    autoTopupAmount: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    provider: 'stripe',
    demoEnterprise: false,
    lastDailyRefresh: null,
    commitmentType: null,
    commitmentEndDate: null,
    scheduledTierChange: null,
    scheduledTierChangeDate: null,
    revenuecatCancelledAt: null,
    revenuecatSubscriptionId: null,
    revenuecatCustomerId: null,
    revenuecatPendingChangeProduct: null,
    revenuecatPendingChangeDate: null,
    planType: null,
    seatCount: null,
    maxConcurrentSessions: null,
    ...overrides,
  };
}

describe('buildMinimalAccountState — credit row dedupe + concurrency (measured p95 3,537ms / p99 8,977ms fix)', () => {
  test('fetches the credit_accounts row exactly once per request', async () => {
    getCreditAccountCalls = 0;
    account = creditAccount();

    await buildMinimalAccountState('acct-1');

    expect(getCreditAccountCalls).toBe(1);
  });

  test('the independent lookups actually run concurrently, not sequentially', async () => {
    getCreditAccountCalls = 0;
    account = creditAccount({ billingModel: 'per_seat' });
    inFlight = 0;
    maxInFlight = 0;

    await buildMinimalAccountState('acct-1');

    expect(maxInFlight).toBeGreaterThan(1);
  });

  test('response shape is unchanged — credits, subscription, tier, auto_topup, instances, limits all present', async () => {
    getCreditAccountCalls = 0;
    account = creditAccount();

    const state = await buildMinimalAccountState('acct-1');

    expect(state.credits).toEqual({
      total: 10,
      daily: 1,
      monthly: 5,
      extra: 4,
      can_run: true,
      lifetime_granted: 0,
      lifetime_purchased: 0,
      lifetime_used: 0,
      daily_refresh: null,
    });
    expect(state.subscription.tier_key).toBe('free');
    expect(state.tier.name).toBe('free');
    expect(state.auto_topup).toEqual({
      enabled: false,
      threshold: expect.any(Number),
      amount: expect.any(Number),
    });
    expect(state.instances).toEqual([]);
    expect(state.limits?.concurrent_sessions.active).toBe(0);
    expect(state.billing_model).toBe('legacy');
    expect(state.member_count).toBe(3);
    expect(state.billing_state).toBe('active');
    expect(state.has_active_subscription).toBe(false);
  });

  test('a per-seat account on an ACTIVE subscription with a drained wallet can still run', async () => {
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0.0099614711',
      stripeSubscriptionId: 'sub_live',
      stripeSubscriptionStatus: 'active',
    });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.billing_state).toBe('active');
    expect(state.credits.can_run).toBe(true);
    expect(state.has_active_subscription).toBe(true);
  });

  test('a per-seat account whose subscription lapsed and whose wallet is drained is out_of_credits, not no_subscription', async () => {
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0',
      stripeSubscriptionId: 'sub_gone',
      stripeSubscriptionStatus: 'canceled',
    });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.billing_state).toBe('out_of_credits');
    expect(state.credits.can_run).toBe(false);
    expect(state.has_active_subscription).toBe(false);
  });

  test('lifetime rollups are surfaced from the credit row rather than hardcoded to zero', async () => {
    account = creditAccount({
      lifetimeGranted: '27.0000000000',
      lifetimePurchased: '20.0000000000',
      lifetimeUsed: '14.5000000000',
    });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.credits.lifetime_granted).toBe(27);
    expect(state.credits.lifetime_purchased).toBe(20);
    expect(state.credits.lifetime_used).toBe(14.5);
  });

  test('when no credit row exists, the account is initialized and the fresh row is still read only once more (not re-fetched by downstream helpers)', async () => {
    getCreditAccountCalls = 0;
    account = null;

    // initializeFreeTierAccount is mocked as a no-op, so the account stays
    // null even after "initialization" here — this only asserts the call
    // count discipline: one probe fetch + one post-init fetch, no extra
    // reads from getCreditSummary / getAccountEntitlements / getAutoTopupSettings.
    await buildMinimalAccountState('acct-1');

    expect(getCreditAccountCalls).toBe(2);
  });
});

/**
 * STORED vs RESOLVED plan in one response.
 *
 * A trial is an entitlement OVERLAY: it never writes `credit_accounts.tier`
 * (the Stripe webhook reconciliation owns that column and would clobber it), so
 * a trialing account's stored tier stays 'free' while every gate in the product
 * enforces the trial plan. account-state used to describe the stored tier only,
 * which meant the dashboard told a trialing account it was on Free while the
 * server let it do everything the trial plan allows.
 *
 * The response now carries both, and each name says which it is:
 *   subscription.tier_key  → STORED. What Stripe sold. Wire-compatible.
 *   plan.* / tier.*        → RESOLVED. What the account behaves as.
 */
describe('buildMinimalAccountState — trialing account reports the trial plan', () => {
  const TRIAL_TIER = 'tier_25_200';

  function trialing(overrides: Record<string, unknown> = {}) {
    return creditAccount({
      tier: 'free',
      trialStatus: 'active',
      trialTier: TRIAL_TIER,
      trialEndsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ...overrides,
    });
  }

  test('tier.* and plan.* describe the TRIAL plan while subscription.tier_key keeps the stored one', async () => {
    account = trialing();

    const state = await buildMinimalAccountState('acct-1');

    // Stored — unchanged wire value.
    expect(state.subscription.tier_key).toBe('free');
    expect(state.subscription.tier_display_name).toBe('Free');

    // Resolved — what the gates enforce.
    expect(state.tier.name).toBe(TRIAL_TIER);
    expect(state.tier.display_name).toBe('Ultra (Legacy)');
    expect(state.plan?.key).toBe(TRIAL_TIER);
    expect(state.plan?.family).toBe('team');
    expect(state.plan?.label).toBe('Team');
    expect(state.plan?.status).toBe('grandfathered');
    expect(state.plan?.is_grandfathered).toBe(true);
    expect(state.plan?.shape).toBe('flat');
    expect(state.plan?.sublabel).toBe('$200/mo · grandfathered');
  });

  test('the concurrent-session ceiling shown is the trial plan’s, not free’s', async () => {
    account = trialing();

    const state = await buildMinimalAccountState('acct-1');

    expect(state.limits?.concurrent_sessions.limit).toBe(
      getTier(TRIAL_TIER).concurrentSessionLimit,
    );
    expect(state.limits?.concurrent_sessions.limit).not.toBe(
      getTier('free').concurrentSessionLimit,
    );
  });

  test('credit purchases follow the resolved plan — the same predicate the purchase route gates on', async () => {
    account = trialing();

    const state = await buildMinimalAccountState('acct-1');

    expect(state.tier.can_purchase_credits).toBe(true);
    expect(state.subscription.can_purchase_credits).toBe(true);
  });

  test('monthly_credits stays on the STORED plan — a trial grants no credits', async () => {
    account = trialing();

    const state = await buildMinimalAccountState('acct-1');

    expect(state.tier.monthly_credits).toBe(getTier('free').monthlyCredits);
  });

  test('an expired trial falls back to the stored plan with no cron involved', async () => {
    account = trialing({ trialEndsAt: new Date(Date.now() - 1_000).toISOString() });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.tier.name).toBe('free');
    expect(state.plan?.key).toBe('free');
    expect(state.plan?.family).toBe('free');
    expect(state.plan?.is_grandfathered).toBe(false);
    expect(state.tier.can_purchase_credits).toBe(false);
  });

  test('a per-account session override still wins over the resolved plan cap', async () => {
    account = trialing({ maxConcurrentSessions: 7 });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.limits?.concurrent_sessions.limit).toBe(7);
  });

  test('an ordinary free account is unchanged — plan block reports Free', async () => {
    account = creditAccount();

    const state = await buildMinimalAccountState('acct-1');

    expect(state.subscription.tier_key).toBe('free');
    expect(state.tier.name).toBe('free');
    expect(state.plan?.key).toBe('free');
    expect(state.plan?.family).toBe('free');
    expect(state.plan?.status).toBe('current');
    expect(state.plan?.sublabel).toBeNull();
    expect(state.plan?.rank).toBe(1);
  });
});

/**
 * The concurrency limit the dashboard SHOWS must be the one the server ENFORCES.
 *
 * resolveAccountSessionLimit coerces a paying per-seat account whose stored
 * `tier` is stale to 'per_seat', so bad tier data cannot gate a paying team as
 * free. account-state read the raw `tier` column instead, so such an account
 * was shown the FREE ceiling while the server admitted the per-seat one — two
 * independent derivations of a single number.
 */
describe('effectiveTierForLimits', () => {
  const paying = {
    billingModel: 'per_seat',
    stripeSubscriptionId: 'sub_123',
    stripeSubscriptionStatus: 'active',
  };

  test('a paying per-seat account with a stale free tier resolves to per_seat', () => {
    expect(effectiveTierForLimits('free', paying)).toBe('per_seat');
  });

  test('a genuinely free account stays free', () => {
    expect(effectiveTierForLimits('free', { billingModel: 'credits' })).toBe('free');
  });

  test('a cancelled per-seat subscription is not coerced', () => {
    expect(
      effectiveTierForLimits('free', { ...paying, stripeSubscriptionStatus: 'canceled' }),
    ).toBe('free');
  });

  test('an unpaid per-seat subscription is not coerced', () => {
    expect(effectiveTierForLimits('free', { ...paying, stripeSubscriptionStatus: 'unpaid' })).toBe(
      'free',
    );
  });

  test('a per-seat row with no Stripe subscription is not coerced', () => {
    expect(effectiveTierForLimits('free', { ...paying, stripeSubscriptionId: null })).toBe('free');
  });

  test('a null tier defaults to free rather than throwing', () => {
    expect(effectiveTierForLimits(null, null)).toBe('free');
  });
});
