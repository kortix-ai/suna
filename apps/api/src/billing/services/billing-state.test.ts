import { describe, expect, test } from 'bun:test';
import {
  type BillingSnapshot,
  billingSnapshotFromAccount,
  billingStateAllowsRun,
  billingStateNeedsTopUp,
  hasPlan,
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

  test('per-seat subscription in dunning (past_due) keeps running while Stripe retries', () => {
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
    ).toBe('active');
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
