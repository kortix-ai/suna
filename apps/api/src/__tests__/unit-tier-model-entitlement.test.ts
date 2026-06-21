import { describe, expect, test } from 'bun:test';
import {
  isPaidTier,
  tierGrantsAllModels,
} from '../billing/services/tiers';

const PAID_TIER_NAMES = [
  'pro',
  'per_seat',
  'tier_2_20',
  'tier_6_50',
  'tier_12_100',
  'tier_25_200',
  'tier_50_400',
  'tier_125_800',
  'tier_200_1000',
  'tier_150_1200',
];

// The regression this guards: the premium LLM gateway used to be gated on
// `isPerSeatAccount(billing_model)`, which silently stripped every legacy paid
// customer (pro, tier_*) down to OpenCode's Zen-only catalog even though their
// tier config carries models:['all']. Entitlement now keys off the tier, so the
// invariant we lock in here is "every paid tier grants the full model catalog".
describe('tierGrantsAllModels', () => {
  test('every paid tier unlocks the full model catalog', () => {
    // Sanity: the config actually treats the expected paid tiers as paid.
    expect(PAID_TIER_NAMES.every(isPaidTier)).toBe(true);
    for (const tierName of PAID_TIER_NAMES) {
      expect(tierGrantsAllModels(tierName)).toBe(true);
    }
  });

  test('free and none tiers do NOT unlock the premium gateway', () => {
    expect(tierGrantsAllModels('free')).toBe(false);
    expect(tierGrantsAllModels('none')).toBe(false);
  });

  test('per-seat and the legacy pro/tier_* plans are all entitled', () => {
    for (const name of PAID_TIER_NAMES) {
      expect(tierGrantsAllModels(name)).toBe(true);
    }
  });

  test('an unknown tier name falls back to the none tier (no gateway)', () => {
    expect(tierGrantsAllModels('totally-made-up-tier')).toBe(false);
  });
});
