/**
 * Billing facts every surface reads: which plan key a stored tier means, who
 * pays for compute, and the self-serve price range.
 *
 * Credits-only billing: four plan keys (none/free/credits/enterprise). Every
 * legacy key resolves to `credits` through `canonicalTier`. Every account
 * meters compute except a row whose STORED tier is a legacy flat plan.
 * The candidate SQL that mirrors `accountRowMetersCompute` runs on PostgreSQL
 * in compute-metering.integration.test.ts.
 *
 * Pure functions over the tier tables; no mocks.
 */
import { describe, expect, test } from 'bun:test';
import {
  LEGACY_PAID_PLAN_KEYS,
  PLAN_KEYS,
  PLAN_MAX_MONTHLY_USD,
  PLAN_MIN_MONTHLY_USD,
  accountRowMetersCompute,
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

  test('the self-serve range is $20 to $10,000', () => {
    expect(PLAN_MIN_MONTHLY_USD).toBe(20);
    expect(PLAN_MAX_MONTHLY_USD).toBe(10_000);
  });
});

describe('compute metering', () => {
  test('free, none, credits and enterprise accounts meter compute', () => {
    for (const tier of ['free', 'none', 'credits', 'enterprise', null, undefined]) {
      expect(accountRowMetersCompute({ tier })).toBe(true);
    }
  });

  test('a legacy per-seat row meters compute (seat plan folded into credits)', () => {
    expect(accountRowMetersCompute({ tier: 'per_seat' })).toBe(true);
  });

  test('a row whose STORED tier is a legacy flat plan stays unmetered', () => {
    // Read on the raw tier, before the alias. The tier rewrite to `credits`
    // ends this exemption.
    for (const tier of ['tier_2_20', 'tier_6_50', 'tier_25_200', 'tier_200_1000', 'pro']) {
      expect(accountRowMetersCompute({ tier })).toBe(false);
    }
  });

  test('no credit account at all meters nothing', () => {
    expect(accountRowMetersCompute(null)).toBe(false);
    expect(accountRowMetersCompute(undefined)).toBe(false);
  });
});
