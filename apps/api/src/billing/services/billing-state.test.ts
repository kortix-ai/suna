import { describe, expect, test } from 'bun:test';
import {
  type BillingSnapshot,
  billingSnapshotFromAccount,
  billingStateAllowsRun,
  billingStateNeedsTopUp,
  hasLiveSubscription,
  hasPayingSubscription,
  hasPlan,
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

  test('per-seat account on an ACTIVE subscription with an exactly-zero wallet is blocked, not unplanned', () => {
    const state = resolveBillingState(
      snapshot({
        billingModel: 'per_seat',
        tier: 'per_seat',
        balance: 0,
        subscriptionId: 'sub_live',
        subscriptionStatus: 'active',
      }),
    );
    expect(state).toBe('out_of_credits');
    expect(billingStateNeedsTopUp(state)).toBe(true);
  });

  test('per-seat account whose subscription was CANCELED and wallet drained is out_of_credits, not no_subscription', () => {
    const state = resolveBillingState(
      snapshot({
        billingModel: 'per_seat',
        tier: 'per_seat',
        balance: 0,
        subscriptionId: 'sub_gone',
        subscriptionStatus: 'canceled',
        paymentStatus: 'active',
      }),
    );
    expect(state).toBe('out_of_credits');
    expect(billingStateNeedsTopUp(state)).toBe(true);
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

  test('per-seat subscription in dunning (past_due) keeps running on the credit it still has', () => {
    expect(
      resolveBillingState(
        snapshot({
          billingModel: 'per_seat',
          tier: 'per_seat',
          balance: 25,
          subscriptionId: 'sub_dunning',
          subscriptionStatus: 'past_due',
          paymentStatus: 'past_due',
        }),
      ),
    ).toBe('active');
  });

  test('per-seat subscription in dunning with an EMPTY wallet no longer spends without a floor', () => {
    expect(
      resolveBillingState(
        snapshot({
          billingModel: 'per_seat',
          tier: 'per_seat',
          balance: 0,
          subscriptionId: 'sub_dunning',
          subscriptionStatus: 'past_due',
          paymentStatus: 'past_due',
        }),
      ),
    ).toBe('payment_failed');
  });

  test('per-seat subscription gone UNPAID with an empty wallet reports payment_failed, not no_subscription', () => {
    const state = resolveBillingState(
      snapshot({
        billingModel: 'per_seat',
        tier: 'per_seat',
        balance: -9237.85,
        subscriptionId: 'sub_lapsed',
        subscriptionStatus: 'unpaid',
      }),
    );
    expect(state).toBe('payment_failed');
    expect(billingStateNeedsTopUp(state)).toBe(true);
    expect(billingStateAllowsRun(state)).toBe(false);
  });

  test('per-seat subscription that expired before first payment blocks as payment_failed', () => {
    expect(
      resolveBillingState(
        snapshot({
          billingModel: 'per_seat',
          tier: 'per_seat',
          balance: 0,
          subscriptionId: 'sub_incomplete',
          subscriptionStatus: 'incomplete_expired',
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

  test('funded free account is active', () => {
    expect(resolveBillingState(snapshot({ tier: 'free', balance: 2 }))).toBe('active');
  });

  test('balance just below the run floor blocks; exactly at the floor runs', () => {
    expect(resolveBillingState(snapshot({ tier: 'free', balance: 0.009 }))).toBe('no_subscription');
    expect(resolveBillingState(snapshot({ tier: 'free', balance: 0.01 }))).toBe('active');
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
  const EVERY_STRIPE_STATUS = [
    'active',
    'trialing',
    'past_due',
    'incomplete',
    'incomplete_expired',
    'unpaid',
    'canceled',
    'paused',
    '',
  ] as const;

  /** Statuses Stripe is collecting on. No longer a bypass — only a label input. */
  const PAYING = new Set(['active', 'trialing']);

  function perSeat(status: string, balance: number): BillingSnapshot {
    return snapshot({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance,
      subscriptionId: 'sub_x',
      subscriptionStatus: status,
      paymentStatus: null,
    });
  }

  for (const status of EVERY_STRIPE_STATUS) {
    const label = status || '(empty)';

    test(`per-seat "${label}" with an empty wallet CANNOT run, whatever Stripe says`, () => {
      expect(billingStateAllowsRun(resolveBillingState(perSeat(status, 0)))).toBe(false);
    });

    test(`per-seat "${label}" with an empty wallet is never told to subscribe`, () => {
      // It has a subscription row, so `hasPlan` is true and the state must be a
      // top-up/payment state — never the "you have no plan" pitch.
      const state = resolveBillingState(perSeat(status, 0));
      expect(state).not.toBe('no_subscription');
      expect(billingStateNeedsTopUp(state)).toBe(true);
    });

    test(`per-seat "${label}" with a FUNDED wallet runs`, () => {
      expect(resolveBillingState(perSeat(status, 25))).toBe('active');
    });
  }

  test('a paying per-seat account at $0 is out_of_credits — the exact case that used to run unmetered', () => {
    const state = resolveBillingState(perSeat('active', 0));
    expect(state).toBe('out_of_credits');
    expect(billingStateAllowsRun(state)).toBe(false);
    expect(billingStateNeedsTopUp(state)).toBe(true);
  });

  test('a paying per-seat account just under the floor is blocked; at the floor it runs', () => {
    expect(billingStateAllowsRun(resolveBillingState(perSeat('active', 0.0099)))).toBe(false);
    expect(billingStateAllowsRun(resolveBillingState(perSeat('active', 0.01)))).toBe(true);
  });

  test('past_due per-seat with a DRAINED wallet blocks as payment_failed, not out_of_credits', () => {
    // payment_failed is checked BEFORE hasPlan, so a failing card is named as a
    // card problem rather than sent to a top-up flow that will also fail.
    const state = resolveBillingState(perSeat('past_due', 0));
    expect(state).toBe('payment_failed');
    expect(billingStateAllowsRun(state)).toBe(false);
  });

  test('past_due per-seat is NOT told to subscribe — the PR #5141 mislabel stays dead', () => {
    expect(resolveBillingState(perSeat('past_due', 0))).not.toBe('no_subscription');
    expect(billingStateNeedsTopUp(resolveBillingState(perSeat('past_due', 0)))).toBe(true);
  });

  test('past_due per-seat with a FUNDED wallet still runs — Stripe dunning must not cut it off', () => {
    expect(resolveBillingState(perSeat('past_due', 25))).toBe('active');
  });

  test('CONSEQUENCE: a Stripe-trialing per-seat account at $0 now BLOCKS', () => {
    // Deliberate and load-bearing. `trialing` used to bypass the floor, so a
    // trial with an unfunded wallet ran for free. It no longer does.
    //
    // A Stripe trial produces no `invoice.paid`, and the seat grant is driven by
    // `invoice.paid` — so a trial started through Stripe has NO wallet unless
    // something else funds it. Admin-issued trials are fine: trial-admin.ts
    // grants credits explicitly as part of issuing the trial ("even a BYOK
    // trial needs compute credits to run sessions").
    //
    // If Stripe-native trials on the per-seat plan are ever used, they must be
    // funded at trial start or this test is the thing that will have warned you.
    const state = resolveBillingState(perSeat('trialing', 0));
    expect(billingStateAllowsRun(state)).toBe(false);
    expect(state).toBe('out_of_credits');
  });

  test('a trial WITH credits runs — the funded trial path is unaffected', () => {
    expect(resolveBillingState(perSeat('trialing', 25))).toBe('active');
  });

  test('incomplete_expired per-seat cannot spend below the floor', () => {
    expect(resolveBillingState(perSeat('incomplete_expired', 0))).toBe('payment_failed');
  });

  test('an unknown future Stripe status fails CLOSED', () => {
    const snap = perSeat('some_status_stripe_adds_in_2027', 0);
    expect(billingStateAllowsRun(resolveBillingState(snap))).toBe(false);
  });

  test('a FREE account with an active $0 Stripe subscription cannot run', () => {
    // The free tier carries a real Stripe subscription whose status is `active`
    // (226,931 such rows on production, 2026-08-20). Under the old bypass this
    // was the trap that made the paid-plan condition load-bearing; under a
    // universal floor it simply falls out.
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

  test('a paying LEGACY subscription is metered exactly like per-seat', () => {
    // The 2026-08-20 reversal widened the bypass to any paid tier so paying
    // legacy customers were not 402'd at a $0 wallet. With no bypass at all,
    // legacy and per-seat converge: both run on credit and block without it.
    for (const status of EVERY_STRIPE_STATUS) {
      const drained = snapshot({
        billingModel: 'legacy',
        tier: 'tier_2_20',
        balance: 0,
        subscriptionId: 'sub_x',
        subscriptionStatus: status,
      });
      expect(billingStateAllowsRun(resolveBillingState(drained))).toBe(false);
      expect(resolveBillingState(drained)).not.toBe('no_subscription');

      const funded = { ...drained, balance: 25 };
      expect(resolveBillingState(funded)).toBe('active');
    }
  });

  test('hasPayingSubscription survives as a reporting predicate, granting nothing', () => {
    // It still answers "is Stripe collecting" for the webhook layer and for
    // `payment_failed`. It just no longer decides who may spend.
    for (const status of EVERY_STRIPE_STATUS) {
      expect(hasPayingSubscription(perSeat(status, 0))).toBe(PAYING.has(status));
      // ...and being paying buys no run permission on an empty wallet.
      expect(billingStateAllowsRun(resolveBillingState(perSeat(status, 0)))).toBe(false);
    }
  });

  test('no subscription id and an empty wallet means no plan at all', () => {
    const snap = snapshot({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: 0,
      subscriptionId: null,
      subscriptionStatus: 'active',
    });
    expect(hasPayingSubscription(snap)).toBe(false);
    expect(billingStateAllowsRun(resolveBillingState(snap))).toBe(false);
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

  test('agrees with hasPayingSubscription for every status', () => {
    for (const status of ['active', 'trialing', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'canceled']) {
      expect(isPayingSubscriptionStatus(status)).toBe(
        hasPayingSubscription(snapshot({ subscriptionId: 'sub_1', subscriptionStatus: status })),
      );
    }
  });
});

describe('hasPlan — never inferred from tier_key alone (PR #5141 lesson)', () => {
  test('a per-seat account whose tier_key is still "free" but which has a subscription has a plan', () => {
    expect(
      hasPlan(
        snapshot({
          billingModel: 'per_seat',
          tier: 'free',
          subscriptionId: 'sub_live',
          subscriptionStatus: 'active',
        }),
      ),
    ).toBe(true);
  });

  test('billing_model per_seat alone does NOT mean the account is on a plan', () => {
    expect(
      hasPlan(snapshot({ billingModel: 'per_seat', tier: 'free', subscriptionId: null })),
    ).toBe(false);
  });

  test('an account with no credit row has no plan', () => {
    expect(hasPlan({ exists: false, balance: 0 })).toBe(false);
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
