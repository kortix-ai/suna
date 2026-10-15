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
import { getTier } from './tiers';
import * as realUsageBreakdown from './usage-breakdown';
import * as realCreditAccounts from '../repositories/credit-accounts';

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
  ...realCreditAccounts,
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
  },
}));

const { buildMinimalAccountState } = await import('./account-state');

function creditAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    tier: 'free',
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
    planMonthlyUsd: null,
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
    account = creditAccount();
    inFlight = 0;
    maxInFlight = 0;

    await buildMinimalAccountState('acct-1');

    expect(maxInFlight).toBeGreaterThan(1);
  });

  test('response shape — credits, subscription, tier, auto_topup present; no legacy machine fields', async () => {
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
    expect(state.plan).toMatchObject({
      key: 'free',
      family: 'free',
      status: 'current',
      sublabel: null,
      rank: 1,
      monthly_usd: null,
    });
    expect('is_grandfathered' in (state.plan ?? {})).toBe(false);
    expect(state.auto_topup).toEqual({
      enabled: false,
      threshold: expect.any(Number),
      amount: expect.any(Number),
      // KRTX-1718: why the last charge failed; none here.
      disabled_reason: null,
      last_failure_reason: null,
      last_failure_at: null,
    });
    expect('instances' in state).toBe(false);
    expect('can_add_instances' in state).toBe(false);
    expect('limits' in state).toBe(false);
    // Credits-only: no seats, no billing model, no claim flags.
    for (const removed of ['billing_model', 'seats', 'member_count', 'can_claim_per_seat', 'can_claim_computer']) {
      expect(removed in state).toBe(false);
    }
    expect(state.plan?.monthly_usd).toBeNull();
    expect(state.billing_state).toBe('active');
    expect(state.has_active_subscription).toBe(false);
  });

  test('a credits account on an ACTIVE subscription with a drained wallet CANNOT run, and reports why', async () => {
    // Was `can_run: true` while the wallet sat at $0.0099, because a paying
    // subscription bypassed the floor. The bypass is gone. What this
    // test now pins is that the three fields stay CONSISTENT with each other:
    // blocked (`can_run` false), correctly diagnosed (`out_of_credits`, so the
    // UI says "Top up"), and still recognised as a customer
    // (`has_active_subscription` true, so nothing pitches them a subscription).
    account = creditAccount({
      tier: 'credits',
      planMonthlyUsd: '100',
      balance: '0.0099614711',
      stripeSubscriptionId: 'sub_live',
      stripeSubscriptionStatus: 'active',
    });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.billing_state).toBe('out_of_credits');
    expect(state.credits.can_run).toBe(false);
    expect(state.has_active_subscription).toBe(true);
    expect(state.plan?.monthly_usd).toBe(100);
    expect(state.tier.monthly_credits).toBe(100);
  });

  test('a credits account whose subscription lapsed and whose wallet is drained is out_of_credits, not no_subscription', async () => {
    account = creditAccount({
      tier: 'credits',
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
describe('buildMinimalAccountState — the Enterprise feature layer', () => {
  test('off by default; trial is always null', async () => {
    account = creditAccount({ tier: 'credits', planMonthlyUsd: '200' });
    const state = await buildMinimalAccountState('acct-1');
    expect(state.enterprise).toEqual({ state: 'off' });
    expect(state.trial).toBeNull();
    expect(state.plan?.family).toBe('credits');
  });

  test('demo: Enterprise features on, the billing plan and its amount unchanged, plan limits', async () => {
    account = creditAccount({ tier: 'credits', planMonthlyUsd: '200', demoEnterprise: true });
    const state = await buildMinimalAccountState('acct-1');
    expect(state.enterprise).toEqual({ state: 'demo' });
    expect(state.plan?.family).toBe('credits');
    expect(state.plan?.monthly_usd).toBe(200);
    expect(state.subscription.monthly_usd).toBe(200);
    expect(state.tier.name).toBe('credits');
    expect(state.tier.entitlements?.sso).toBe(true);
  });

  test('licensed: Enterprise limits at the gates, the billing plan unchanged', async () => {
    account = creditAccount({ tier: 'free', enterpriseEntitled: true });
    const state = await buildMinimalAccountState('acct-1');
    expect(state.enterprise).toEqual({ state: 'licensed' });
    expect(state.plan?.family).toBe('free');
    expect(state.tier.name).toBe('enterprise');
  });

  test('a stale active trial on the row grants nothing', async () => {
    account = creditAccount({ tier: 'free', trialStatus: 'active', trialTier: 'enterprise', trialEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
    const state = await buildMinimalAccountState('acct-1');
    expect(state.enterprise).toEqual({ state: 'off' });
    expect(state.trial).toBeNull();
    expect(state.tier.entitlements?.sso).toBe(false);
  });
});

/**
 * Pending cancellation (`subscription.cancel_at_period_end`).
 *
 * Stripe is the truth; `payment_status: 'cancelling'` is its mirror on the
 * credit row (the `customer.subscription.updated` webhook writes it, and the
 * cancel route writes it eagerly so the UI flips without waiting on webhook
 * latency). account-state hardcoded `cancel_at_period_end: false`, so a
 * subscription the customer had cancelled kept rendering as if it renewed
 * forever and the app had no state to show a pending cancellation against.
 * These pin the mirror both ways.
 */
describe('buildMinimalAccountState — reports a pending cancellation from paymentStatus', () => {
  function cancelling(overrides: Record<string, unknown> = {}) {
    return creditAccount({
      tier: 'credits',
      stripeSubscriptionId: 'sub_cancelling',
      stripeSubscriptionStatus: 'active',
      ...overrides,
    });
  }

  test('paymentStatus cancelling → cancel_at_period_end true, subscription still live', async () => {
    account = cancelling({ paymentStatus: 'cancelling' });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.subscription.cancel_at_period_end).toBe(true);
    expect(state.subscription.subscription_id).toBe('sub_cancelling');
    expect(state.has_active_subscription).toBe(true);
  });

  test('paymentStatus active → cancel_at_period_end false', async () => {
    account = cancelling({ paymentStatus: 'active' });

    const state = await buildMinimalAccountState('acct-1');

    expect(state.subscription.cancel_at_period_end).toBe(false);
  });
});

describe('buildMinimalAccountState — plan changes', () => {
  test('a scheduled cut: this period keeps its amount; scheduled_change names the new one and the renewal date', async () => {
    account = creditAccount({
      tier: 'credits',
      planMonthlyUsd: '5000',
      scheduledMonthlyUsd: '3000',
      scheduledTierChangeDate: '2026-11-14T00:00:00.000Z',
      stripeSubscriptionId: 'sub_live',
      billingCycleAnchor: '2026-09-14T00:00:00.000Z',
    });
    const state = await buildMinimalAccountState('acct-1');
    expect(state.plan?.monthly_usd).toBe(5000);
    expect(state.subscription.has_scheduled_change).toBe(true);
    expect(state.subscription.scheduled_change).toEqual({
      type: 'downgrade',
      current_tier: { name: 'credits', display_name: 'Credits', monthly_credits: 500_000, monthly_usd: 5000 },
      target_tier: { name: 'credits', display_name: 'Credits', monthly_credits: 300_000, monthly_usd: 3000 },
      effective_date: '2026-11-14T00:00:00.000Z',
    });
  });

  test('current_period_end is the next anchor-aligned renewal for a live credits subscription', async () => {
    const anchor = new Date(Date.UTC(2026, 0, 14));
    account = creditAccount({ tier: 'credits', planMonthlyUsd: '100', stripeSubscriptionId: 'sub_live', billingCycleAnchor: anchor.toISOString() });
    const state = await buildMinimalAccountState('acct-1');
    const end = new Date((state.subscription.current_period_end ?? 0) * 1000);
    expect(end.getUTCDate()).toBe(14);
    expect(end.getTime()).toBeGreaterThan(Date.now());
    expect(end.getTime() - Date.now()).toBeLessThanOrEqual(31 * 86_400_000);
  });

  test('no live subscription: no period end, no scheduled change', async () => {
    account = creditAccount({ tier: 'free' });
    const state = await buildMinimalAccountState('acct-1');
    expect(state.subscription.current_period_end).toBeNull();
    expect(state.subscription.scheduled_change).toBeNull();
  });
});
