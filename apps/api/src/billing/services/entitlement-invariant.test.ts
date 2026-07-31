import { describe, expect, test } from 'bun:test';
import {
  ENTITLEMENT_BREACH_THRESHOLD_USD,
  ENTITLEMENT_DRIFT_TOLERANCE_USD,
  expectedMonthlyEntitlementUsd,
  expiringCreditExceedsEntitlement,
  expiringCreditIsNegative,
} from './entitlement-invariant';

describe('expectedMonthlyEntitlementUsd', () => {
  test('free tier is $2', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'free' })).toBe(2);
  });

  test('pro tier is $0 — its $5 is a one-time machine bonus, not a monthly allowance', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'pro' })).toBe(0);
  });

  test('per-seat is $25 per seat, never the $40 price', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'per_seat', seatCount: 1 })).toBe(25);
    expect(expectedMonthlyEntitlementUsd({ tier: 'per_seat', seatCount: 6 })).toBe(150);
    expect(expectedMonthlyEntitlementUsd({ tier: 'per_seat', seatCount: 8 })).toBe(200);
    expect(expectedMonthlyEntitlementUsd({ tier: 'per_seat', seatCount: 6 })).not.toBe(240);
  });

  test('billing_model per_seat is enough even when tier_key still reads free', () => {
    expect(
      expectedMonthlyEntitlementUsd({ tier: 'free', billingModel: 'per_seat', seatCount: 4 }),
    ).toBe(100);
  });

  test('a per-seat account with a missing or zero seat count still bills one seat', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'per_seat', seatCount: null })).toBe(25);
    expect(expectedMonthlyEntitlementUsd({ tier: 'per_seat', seatCount: 0 })).toBe(25);
  });

  test('legacy tiers are 1:1 with their price', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'tier_2_20' })).toBe(20);
    expect(expectedMonthlyEntitlementUsd({ tier: 'tier_6_50' })).toBe(50);
  });

  test('an unknown tier does not grant an allowance', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'tier_that_does_not_exist' })).toBe(0);
    expect(expectedMonthlyEntitlementUsd({})).toBe(0);
  });
});

describe('expiringCreditExceedsEntitlement — the drift this makes visible', () => {
  test('an account exactly at its allowance is clean', () => {
    expect(
      expiringCreditExceedsEntitlement({ tier: 'per_seat', seatCount: 2, expiringCredits: '50' }),
    ).toBeNull();
  });

  test('an account below its allowance is clean — spending is not drift', () => {
    expect(
      expiringCreditExceedsEntitlement({ tier: 'tier_2_20', expiringCredits: '3.21' }),
    ).toBeNull();
  });

  test('the $40-per-seat grant bug is caught on the FIRST seat addition', () => {
    const breach = expiringCreditExceedsEntitlement({
      tier: 'per_seat',
      seatCount: 1,
      expiringCredits: '40',
    });
    expect(breach).not.toBeNull();
    expect(breach?.expectedUsd).toBe(25);
    expect(breach?.actualUsd).toBe(40);
    expect(breach?.excessUsd).toBe(15);
  });

  test('a doubled activation grant is caught', () => {
    const breach = expiringCreditExceedsEntitlement({
      tier: 'per_seat',
      seatCount: 6,
      expiringCredits: '300',
    });
    expect(breach?.expectedUsd).toBe(150);
    expect(breach?.excessUsd).toBe(150);
  });

  test('rounding noise within tolerance is not reported', () => {
    expect(
      expiringCreditExceedsEntitlement({
        tier: 'tier_2_20',
        expiringCredits: String(20 + ENTITLEMENT_DRIFT_TOLERANCE_USD),
      }),
    ).toBeNull();
  });

  test('an excess just past the reporting threshold IS reported', () => {
    expect(
      expiringCreditExceedsEntitlement({
        tier: 'tier_2_20',
        expiringCredits: String(20 + ENTITLEMENT_BREACH_THRESHOLD_USD + 0.01),
      }),
    ).not.toBeNull();
  });

  test('a subscriber who upgraded before spending the free $2 is NOT a breach', () => {
    // The activation grant is additive, not a reset, so allowance + the unspent
    // free-tier welcome grant is the correct expiring balance for a first cycle.
    // Reporting it would make the guard red for every new paying customer.
    expect(
      expiringCreditExceedsEntitlement({ tier: 'tier_2_20', expiringCredits: '22' }),
    ).toBeNull();
    expect(
      expiringCreditExceedsEntitlement({
        tier: 'per_seat',
        billingModel: 'per_seat',
        seatCount: 1,
        expiringCredits: '27',
      }),
    ).toBeNull();
  });

  test('a pro account holding monthly expiring credit is drift — pro grants none', () => {
    const breach = expiringCreditExceedsEntitlement({ tier: 'pro', expiringCredits: '5' });
    expect(breach?.expectedUsd).toBe(0);
    expect(breach?.excessUsd).toBe(5);
  });

  test('a free account left holding a paid allowance after downgrade is caught', () => {
    const breach = expiringCreditExceedsEntitlement({ tier: 'free', expiringCredits: '20' });
    expect(breach?.expectedUsd).toBe(2);
    expect(breach?.excessUsd).toBe(18);
  });

  test('a free wallet double-granted to $4 is still reported — no paid-tier headroom applies', () => {
    const breach = expiringCreditExceedsEntitlement({ tier: 'free', expiringCredits: '4' });
    expect(breach?.expectedUsd).toBe(2);
    expect(breach?.excessUsd).toBe(2);
  });

  test('a null expiring balance is clean, not a crash', () => {
    expect(expiringCreditExceedsEntitlement({ tier: 'free', expiringCredits: null })).toBeNull();
    expect(expiringCreditExceedsEntitlement({ tier: 'free' })).toBeNull();
  });
});

describe('expiringCreditIsNegative', () => {
  test('a negative expiring bucket is flagged', () => {
    expect(expiringCreditIsNegative({ expiringCredits: '-648.70' })).toBe(true);
  });

  test('zero and positive are not', () => {
    expect(expiringCreditIsNegative({ expiringCredits: '0' })).toBe(false);
    expect(expiringCreditIsNegative({ expiringCredits: '25' })).toBe(false);
    expect(expiringCreditIsNegative({})).toBe(false);
  });
});
