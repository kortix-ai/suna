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
  subscriptionBypassesWalletFloor,
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
  test('per-seat account on an ACTIVE subscription with a drained wallet is active, not blocked', () => {
    const state = resolveBillingState(
      snapshot({
        billingModel: 'per_seat',
        tier: 'per_seat',
        balance: 0.0099614711,
        subscriptionId: 'sub_live',
        subscriptionStatus: 'active',
      }),
    );
    expect(state).toBe('active');
    expect(billingStateAllowsRun(state)).toBe(true);
  });

  test('per-seat account on an ACTIVE subscription with an exactly-zero wallet is still active', () => {
    expect(
      resolveBillingState(
        snapshot({
          billingModel: 'per_seat',
          tier: 'per_seat',
          balance: 0,
          subscriptionId: 'sub_live',
          subscriptionStatus: 'active',
        }),
      ),
    ).toBe('active');
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

describe('only a PAYING subscription bypasses the wallet floor', () => {
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

  const BYPASSES = new Set(['active', 'trialing']);

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

    test(`per-seat "${label}" with an empty wallet: bypass=${BYPASSES.has(status)}`, () => {
      const snap = perSeat(status, 0);
      expect(subscriptionBypassesWalletFloor(snap)).toBe(BYPASSES.has(status));
      expect(billingStateAllowsRun(resolveBillingState(snap))).toBe(BYPASSES.has(status));
    });

    test(`per-seat "${label}" agrees between the gate predicate and the resolved state`, () => {
      const snap = perSeat(status, 0);
      if (subscriptionBypassesWalletFloor(snap)) {
        expect(resolveBillingState(snap)).toBe('active');
      } else {
        expect(resolveBillingState(snap)).not.toBe('active');
      }
    });
  }

  test('past_due per-seat with a DRAINED wallet blocks, and blocks as payment_failed', () => {
    const state = resolveBillingState(perSeat('past_due', 0));
    expect(state).toBe('payment_failed');
    expect(billingStateAllowsRun(state)).toBe(false);
  });

  test('past_due per-seat is NOT told to subscribe — the PR #5141 mislabel', () => {
    expect(resolveBillingState(perSeat('past_due', 0))).not.toBe('no_subscription');
    expect(billingStateNeedsTopUp(resolveBillingState(perSeat('past_due', 0)))).toBe(true);
  });

  test('past_due per-seat with a FUNDED wallet still runs — Stripe dunning must not cut it off', () => {
    expect(resolveBillingState(perSeat('past_due', 25))).toBe('active');
  });

  test('past_due per-seat with a funded wallet is metered: it does NOT bypass the floor', () => {
    expect(subscriptionBypassesWalletFloor(perSeat('past_due', 25))).toBe(false);
  });

  test('incomplete_expired per-seat cannot spend below the floor', () => {
    expect(subscriptionBypassesWalletFloor(perSeat('incomplete_expired', 0))).toBe(false);
    expect(resolveBillingState(perSeat('incomplete_expired', 0))).toBe('payment_failed');
  });

  test('trialing per-seat bypasses the floor — a trial is a live subscription', () => {
    expect(subscriptionBypassesWalletFloor(perSeat('trialing', 0))).toBe(true);
    expect(resolveBillingState(perSeat('trialing', 0))).toBe('active');
  });

  test('an unknown future Stripe status fails CLOSED rather than granting a blank cheque', () => {
    const snap = perSeat('some_status_stripe_adds_in_2027', 0);
    expect(subscriptionBypassesWalletFloor(snap)).toBe(false);
    expect(billingStateAllowsRun(resolveBillingState(snap))).toBe(false);
  });

  test('a LEGACY account never bypasses the floor, whatever its subscription status', () => {
    for (const status of EVERY_STRIPE_STATUS) {
      expect(
        subscriptionBypassesWalletFloor(
          snapshot({
            billingModel: 'legacy',
            tier: 'tier_2_20',
            balance: 0,
            subscriptionId: 'sub_x',
            subscriptionStatus: status,
          }),
        ),
      ).toBe(false);
    }
  });

  test('no subscription id means no bypass even when the status reads active', () => {
    expect(
      subscriptionBypassesWalletFloor(
        snapshot({
          billingModel: 'per_seat',
          tier: 'per_seat',
          balance: 0,
          subscriptionId: null,
          subscriptionStatus: 'active',
        }),
      ),
    ).toBe(false);
  });

  test('hasLiveSubscription stays a REPORTING predicate and still counts past_due as live', () => {
    expect(hasLiveSubscription(perSeat('past_due', 0))).toBe(true);
    expect(hasPayingSubscription(perSeat('past_due', 0))).toBe(false);
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
