import { describe, expect, test } from 'bun:test';
import {
  expectedMonthlyEntitlementUsd,
  expiringCreditExceedsEntitlement,
  expiringCreditIsNegative,
} from './entitlement-invariant';

describe('expectedMonthlyEntitlementUsd', () => {
  test('free tier is $2', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'free' })).toBe(2);
  });

  // REVERSED 2026-08-20 (PR #6662). `pro` granting $0 per cycle was not a
  // design, it was the defect: those customers paid monthly and their renewal
  // granted nothing. A renewal now grants `amount_paid × ratio`, so the ceiling
  // a legitimate cycle can reach is the dearest machine at that ratio.
  test('a paid tier with no catalog grant expects the amount-based ceiling, not $0', () => {
    expect(expectedMonthlyEntitlementUsd({ tier: 'pro' })).toBe(50); // $80 × 0.625
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
  // Spending is not drift: a balance at or below the allowance is clean.
  test.each([
    ['exactly at its allowance', { tier: 'per_seat', seatCount: 2, expiringCredits: '50' }],
    ['below its allowance', { tier: 'tier_2_20', expiringCredits: '3.21' }],
  ])('an account %s is clean', (_name, subject) => {
    expect(expiringCreditExceedsEntitlement(subject)).toBeNull();
  });

  test.each([
    // The $40-per-seat grant bug, caught on the FIRST seat addition.
    ['a $40 seat grant', 1, '40', { expectedUsd: 25, actualUsd: 40, excessUsd: 15 }],
    ['a doubled activation grant', 6, '300', { expectedUsd: 150, actualUsd: 300, excessUsd: 150 }],
  ])('%s is caught', (_name, seatCount, expiringCredits, breach) => {
    expect(expiringCreditExceedsEntitlement({ tier: 'per_seat', seatCount, expiringCredits })).toEqual(breach);
  });

  // A paid tier tolerates $0.50 of rounding plus the $2 free grant a first
  // cycle carries in; a free tier tolerates only the $0.50.
  test.each([
    ['a paid tier at its threshold is clean', 'tier_2_20', '22.5', false],
    ['a paid tier past its threshold is reported', 'tier_2_20', '22.51', true],
    ['the free tier at its tolerance is clean', 'free', '2.5', false],
    ['the free tier past its tolerance is reported', 'free', '2.51', true],
  ])('%s', (_name, tier, expiringCredits, reported) => {
    expect(expiringCreditExceedsEntitlement({ tier, expiringCredits }) !== null).toBe(reported);
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

  test('a pro account above the dearest-machine ceiling is still caught', () => {
    const breach = expiringCreditExceedsEntitlement({ tier: 'pro', expiringCredits: '500' });
    expect(breach?.expectedUsd).toBe(50);
    expect(breach?.excessUsd).toBe(450);
  });

  // No paid-tier headroom applies to a free wallet.
  test.each([
    ['a paid allowance left after a downgrade', '20', 18],
    ['a double-granted $4', '4', 2],
  ])('a free wallet holding %s is reported', (_name, expiringCredits, excessUsd) => {
    expect(expiringCreditExceedsEntitlement({ tier: 'free', expiringCredits })).toMatchObject({
      expectedUsd: 2,
      excessUsd,
    });
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
