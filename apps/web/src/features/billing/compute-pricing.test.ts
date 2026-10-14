import { describe, expect, test } from 'bun:test';
import {
  CREDIT_TIER_GROUPS,
  CREDIT_TIERS,
  CREDITS_PLAN_MAX_USD,
  CREDITS_PLAN_MIN_USD,
  DEFAULT_COMPUTE_CREDITS_PER_HOUR,
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  DEFAULT_TIER_USD,
  isValidMonthlyUsd,
  monthlyCreditsForUsd,
  sessionsForCredits,
  tierForMonthlyUsd,
} from './compute-pricing';

describe('credit tier ladder', () => {
  test('runs $50 to $10,000, ascending, every tier a valid API amount', () => {
    const amounts = CREDIT_TIERS.map((tier) => tier.monthlyUsd);
    expect(amounts[0]).toBe(CREDITS_PLAN_MIN_USD);
    expect(amounts.at(-1)).toBe(CREDITS_PLAN_MAX_USD);
    expect([...amounts].sort((a, b) => a - b)).toEqual(amounts);
    for (const amount of amounts) expect(isValidMonthlyUsd(amount)).toBe(true);
  });

  test('exactly one tier is most popular, and the pages open on it: $200', () => {
    expect(CREDIT_TIERS.filter((tier) => tier.popular).map((tier) => tier.monthlyUsd)).toEqual([200]);
    expect(DEFAULT_TIER_USD).toBe(200);
  });

  test('every group has tiers, in ladder order', () => {
    const groups = CREDIT_TIERS.map((tier) => tier.group);
    expect([...new Set(groups)]).toEqual([...CREDIT_TIER_GROUPS]);
  });

  test('1 credit = $0.01 at every tier: no volume bonus', () => {
    for (const tier of CREDIT_TIERS) {
      expect(monthlyCreditsForUsd(tier.monthlyUsd)).toBe(tier.monthlyUsd * 100);
    }
  });

  test('an off-ladder amount (a legacy $20 plan) has no tier', () => {
    expect(tierForMonthlyUsd(20)).toBeUndefined();
    expect(tierForMonthlyUsd(null)).toBeUndefined();
    expect(tierForMonthlyUsd(500)?.group).toBe('growing');
  });

  test('valid amounts are whole dollars from $50 to $10,000', () => {
    expect(isValidMonthlyUsd(49)).toBe(false);
    expect(isValidMonthlyUsd(20)).toBe(false);
    expect(isValidMonthlyUsd(10_001)).toBe(false);
    expect(isValidMonthlyUsd(75.5)).toBe(false);
    expect(isValidMonthlyUsd(null)).toBe(false);
    expect(isValidMonthlyUsd(Number.NaN)).toBe(false);
  });
});

describe('what credits buy', () => {
  test('the default computer uses about 20 credits a running hour', () => {
    expect(DEFAULT_COMPUTE_HOURLY_PRICE_USD).toBeCloseTo(0.201312, 8);
    expect(DEFAULT_COMPUTE_CREDITS_PER_HOUR).toBe(20);
  });

  test('sessions estimate: credits / p75 to credits / median, rounded', () => {
    expect(sessionsForCredits(20_000)).toEqual([830, 3300]);
    expect(sessionsForCredits(5_000)).toEqual([210, 830]);
  });
});
