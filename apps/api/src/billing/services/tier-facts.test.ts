/**
 * Billing facts every surface reads: which plan key a stored tier means and
 * the self-serve price range.
 *
 * Credits-only billing: four plan keys (none/free/credits/enterprise). Every
 * legacy key resolves to `credits` through `canonicalTier`. Every account with
 * a credit row meters compute (compute-metering.integration.test.ts).
 *
 * Pure functions over the tier tables; no mocks.
 */
import { describe, expect, test } from 'bun:test';
import {
  LEGACY_PAID_PLAN_KEYS,
  PLAN_KEYS,
  PLAN_MAX_MONTHLY_USD,
  PLAN_MIN_MONTHLY_USD,
  canonicalTier,
  isPaidTier,
} from './tiers';

describe('canonicalTier', () => {
  test('the four plan keys are exactly none/free/credits/enterprise', () => {
    expect([...PLAN_KEYS]).toEqual(['none', 'free', 'credits', 'enterprise']);
  });

  test('current keys map to themselves', () => {
    for (const key of PLAN_KEYS) expect(canonicalTier(key)).toBe(key);
  });

  test('every legacy paid key resolves to credits', () => {
    expect(LEGACY_PAID_PLAN_KEYS.length).toBeGreaterThan(0);
    for (const key of LEGACY_PAID_PLAN_KEYS) expect(canonicalTier(key)).toBe('credits');
    for (const key of ['per_seat', 'pro', 'team', 'tier_2_20', 'tier_200_1000']) {
      expect(canonicalTier(key)).toBe('credits');
    }
  });

  test('null, undefined and unknown keys fail closed to none', () => {
    for (const key of [null, undefined, '', 'bogus']) expect(canonicalTier(key)).toBe('none');
  });

  test('isPaidTier is false only for free and none', () => {
    expect(isPaidTier('free')).toBe(false);
    expect(isPaidTier('none')).toBe(false);
    expect(isPaidTier('credits')).toBe(true);
    expect(isPaidTier('enterprise')).toBe(true);
  });

  test('the self-serve range is $50 to $50,000', () => {
    expect(PLAN_MIN_MONTHLY_USD).toBe(50);
    expect(PLAN_MAX_MONTHLY_USD).toBe(50_000);
  });
});

