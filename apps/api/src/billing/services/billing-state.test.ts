import { describe, expect, test } from 'bun:test';
import {
  type BillingSnapshot,
  billingSnapshotFromAccount,
  billingStateAllowsRun,
  billingStateNeedsTopUp,
  isPayingSubscriptionStatus,
  resolveBillingState,
} from './billing-state';

function snapshot(overrides: Partial<BillingSnapshot> = {}): BillingSnapshot {
  return {
    exists: true,
    balance: 100,
    billingModel: 'legacy',
    tier: 'free',
    subscriptionId: null,
    subscriptionStatus: null,
    paymentStatus: 'active',
    ...overrides,
  };
}

describe('resolveBillingState — subscribed-but-broke is never "no plan"', () => {
  test('per-seat account on an ACTIVE subscription with a drained wallet is BLOCKED — but as out_of_credits', () => {
    // This pair of tests used to assert `active`, because a paying per-seat
    // subscription bypassed the wallet floor outright. That bypass is gone (see
    // "NO account bypasses the wallet floor" below for why). The point this file
    // exists to defend is unchanged and is what the second assertion pins: the
    // account is blocked, and it is named a TOP-UP problem, never "no plan".
    const state = resolveBillingState(
      snapshot({
        billingModel: 'per_seat',
        tier: 'per_seat',
        balance: 0.0099614711,
        subscriptionId: 'sub_live',
        subscriptionStatus: 'active',
      }),
    );
    expect(state).toBe('out_of_credits');
    expect(billingStateAllowsRun(state)).toBe(false);
    expect(state).not.toBe('no_subscription');
  });

  test('per-seat account that NEVER subscribed with a drained wallet is no_subscription', () => {
    const state = resolveBillingState(
      snapshot({
        billingModel: 'per_seat',
        tier: 'free',
        balance: 0,
        subscriptionId: null,
        subscriptionStatus: null,
      }),
    );
    expect(state).toBe('no_subscription');
    expect(billingStateNeedsTopUp(state)).toBe(false);
  });

  test('a failed card payment on an otherwise active subscription reports payment_failed once the wallet is dry', () => {
    // Isolates `credit_accounts.payment_status`: the subscription status alone
    // would resolve to out_of_credits.
    expect(
      resolveBillingState(
        snapshot({
          billingModel: 'per_seat',
          tier: 'per_seat',
          balance: 0,
          subscriptionId: 'sub_card_failed',
          subscriptionStatus: 'active',
          paymentStatus: 'failed',
        }),
      ),
    ).toBe('payment_failed');
  });

  test('legacy PAID tier with a drained wallet is out_of_credits', () => {
    expect(
      resolveBillingState(
        snapshot({ billingModel: 'legacy', tier: 'tier_2_20', balance: 0, subscriptionId: null }),
      ),
    ).toBe('out_of_credits');
  });

  test('free account with a drained wallet is no_subscription', () => {
    expect(
      resolveBillingState(snapshot({ billingModel: 'legacy', tier: 'free', balance: 0 })),
    ).toBe('no_subscription');
  });

  test('balance just below the run floor blocks; exactly at the floor runs', () => {
    expect(resolveBillingState(snapshot({ tier: 'free', balance: 0.009 }))).toBe('no_subscription');
    expect(resolveBillingState(snapshot({ tier: 'free', balance: 0.01 }))).toBe('active');
    const paying = { billingModel: 'per_seat', tier: 'per_seat', subscriptionId: 'sub_x', subscriptionStatus: 'active' };
    expect(resolveBillingState(snapshot({ ...paying, balance: 0.0099 }))).toBe('out_of_credits');
    expect(resolveBillingState(snapshot({ ...paying, balance: 0.01 }))).toBe('active');
  });

  test('missing credit row is no_account', () => {
    expect(resolveBillingState({ exists: false, balance: 0 })).toBe('no_account');
    expect(billingStateAllowsRun('no_account')).toBe(false);
  });
});

describe('NO account bypasses the wallet floor', () => {
  // The bypass this block used to assert (`subscriptionBypassesWalletFloor`) is
  // GONE. It let a paying per-seat / credit-plan / paid-tier account spend with
  // no floor at all, which on a 6-seat production account produced $588.81 of
  // spend against a $150/mo seat grant on a $0.00 wallet — and, past $0, a
  // silently frozen `credit_ledger` because `atomic_use_credits` refuses to go
  // negative. The floor is now universal.
  //
  // What must NOT come back with it is the PR #5141 mislabel: a drained PAYING
  // account is blocked, but it is blocked as `out_of_credits` ("Top up — your
  // plan and seats are unaffected"), never as `no_subscription` ("Subscribe").
  // Every test below is really asserting that pair: blocked AND correctly named.
  function subscribed(status: string, balance: number, plan: 'per_seat' | 'legacy'): BillingSnapshot {
    return snapshot({
      billingModel: plan,
      tier: plan === 'per_seat' ? 'per_seat' : 'tier_2_20',
      balance,
      subscriptionId: 'sub_x',
      subscriptionStatus: status,
      paymentStatus: null,
    });
  }

  // The exact state of a drained subscribed account per Stripe status. A card
  // Stripe is failing to collect on is named `payment_failed` ("update your
  // card"); every other status is `out_of_credits` ("top up"); none is ever
  // `no_subscription`. Legacy paid plans and per-seat resolve alike: the 2026-08-20
  // bypass for paying legacy customers is gone, so both run on credit.
  //
  // `trialing` at $0 BLOCKS. Deliberate and load-bearing: a Stripe trial
  // produces no `invoice.paid`, and the seat grant is driven by `invoice.paid`,
  // so a trial started through Stripe has NO wallet unless something else funds
  // it. Admin-issued trials are fine: trial-admin.ts grants credits explicitly.
  // If Stripe-native trials on the per-seat plan are ever used, they must be
  // funded at trial start or this row is the thing that will have warned you.
  const DRAINED: ReadonlyArray<[status: string, state: 'out_of_credits' | 'payment_failed']> = [
    ['active', 'out_of_credits'],
    ['trialing', 'out_of_credits'],
    ['past_due', 'payment_failed'],
    ['incomplete', 'payment_failed'],
    ['incomplete_expired', 'payment_failed'],
    ['unpaid', 'payment_failed'],
    ['canceled', 'out_of_credits'],
    ['paused', 'out_of_credits'],
    ['', 'out_of_credits'],
    // An unknown future Stripe status fails CLOSED.
    ['some_status_stripe_adds_in_2027', 'out_of_credits'],
  ];

  for (const plan of ['per_seat', 'legacy'] as const) {
    test.each(DRAINED)(`${plan} "%s" with an empty wallet is %s`, (status, state) => {
      expect(resolveBillingState(subscribed(status, 0, plan))).toBe(state);
    });

    test.each(DRAINED)(`${plan} "%s" with a FUNDED wallet runs`, (status) => {
      expect(resolveBillingState(subscribed(status, 25, plan))).toBe('active');
    });
  }

  test('a drained account whose tier_key still reads free but has a subscription is out_of_credits', () => {
    // A plan is never inferred from tier_key alone (PR #5141 lesson).
    expect(
      resolveBillingState(
        snapshot({ billingModel: 'per_seat', tier: 'free', balance: 0, subscriptionId: 'sub_live', subscriptionStatus: 'active' }),
      ),
    ).toBe('out_of_credits');
  });

  test('a FREE account with an active $0 Stripe subscription cannot run', () => {
    // The free tier carries a real Stripe subscription whose status is `active`
    // (226,931 such rows on production, 2026-08-20). Under the old bypass this
    // was the trap that made the paid-plan condition load-bearing; under a
    // universal floor it simply falls out. The state it reports (today
    // out_of_credits, a top-up the free tier cannot buy) is an open product
    // question, so this row pins only that it cannot run.
    for (const tier of ['free', 'none', null]) {
      const snap = snapshot({
        billingModel: 'legacy',
        tier,
        balance: 0,
        subscriptionId: 'sub_free_tier',
        subscriptionStatus: 'active',
      });
      expect(billingStateAllowsRun(resolveBillingState(snap))).toBe(false);
    }
  });
});

describe('isPayingSubscriptionStatus — the webhook layer activation gate', () => {
  test('only active and trialing are paying', () => {
    expect(isPayingSubscriptionStatus('active')).toBe(true);
    expect(isPayingSubscriptionStatus('trialing')).toBe(true);
  });

  test('a never-paid subscription is not paying — the 85-account/$840 signup farm', () => {
    expect(isPayingSubscriptionStatus('incomplete')).toBe(false);
    expect(isPayingSubscriptionStatus('incomplete_expired')).toBe(false);
  });

  test('a lapsed or terminated subscription is not paying', () => {
    expect(isPayingSubscriptionStatus('past_due')).toBe(false);
    expect(isPayingSubscriptionStatus('unpaid')).toBe(false);
    expect(isPayingSubscriptionStatus('canceled')).toBe(false);
    expect(isPayingSubscriptionStatus('paused')).toBe(false);
  });

  test('an absent or unknown status fails CLOSED', () => {
    expect(isPayingSubscriptionStatus(null)).toBe(false);
    expect(isPayingSubscriptionStatus(undefined)).toBe(false);
    expect(isPayingSubscriptionStatus('')).toBe(false);
    expect(isPayingSubscriptionStatus('some_future_stripe_status')).toBe(false);
  });
});

describe('billingSnapshotFromAccount', () => {
  test('maps a credit_accounts row, coercing the numeric-as-string balance', () => {
    expect(
      billingSnapshotFromAccount({
        balance: '0.0099614711',
        billingModel: 'per_seat',
        tier: 'per_seat',
        stripeSubscriptionId: 'sub_live',
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
      }),
    ).toEqual({
      exists: true,
      balance: 0.0099614711,
      billingModel: 'per_seat',
      tier: 'per_seat',
      subscriptionId: 'sub_live',
      subscriptionStatus: 'active',
      paymentStatus: 'active',
    });
  });

  test('a null row becomes a non-existent snapshot', () => {
    expect(billingSnapshotFromAccount(null)).toEqual({ exists: false, balance: 0 });
  });

  test('an unparseable balance degrades to 0 rather than NaN', () => {
    expect(billingSnapshotFromAccount({ balance: 'not-a-number' }).balance).toBe(0);
  });
});
