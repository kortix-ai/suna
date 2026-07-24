import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import {
  accountIsFreeTierForModels,
  CREDITS_PER_DOLLAR,
  getTier,
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

  test('free tier exposes 200 display credits without premium gateway entitlement', () => {
    const free = getTier('free');
    expect(free.hidden).toBe(false);
    expect(free.monthlyCredits * CREDITS_PER_DOLLAR).toBe(200);
    expect(free.models).not.toContain('all');
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

describe('accountIsFreeTierForModels', () => {
  // The no-arg form reads the AMBIENT config.INTERNAL_KORTIX_ENV, which varies
  // by where the suite runs (provisioned dev box vs CI vs a bare worktree) —
  // so assert only self-consistency with an explicit same-env call, never a
  // specific ambient value.
  test('no-arg form matches the explicit call for the ambient env', () => {
    const ambient = config.INTERNAL_KORTIX_ENV;
    for (const tier of ['free', 'none', 'totally-made-up-tier']) {
      expect(accountIsFreeTierForModels(tier)).toBe(accountIsFreeTierForModels(tier, ambient));
    }
  });

  test('free and none tiers cannot use managed models in any environment', () => {
    for (const env of ['dev', 'preview', 'staging', 'prod']) {
      expect(accountIsFreeTierForModels('free', env)).toBe(true);
      expect(accountIsFreeTierForModels('none', env)).toBe(true);
    }
  });

  test('wallet balance cannot affect managed-model entitlement', () => {
    for (const balance of [0, 0.01, 200, 1_000_000]) {
      expect(balance).toBeGreaterThanOrEqual(0);
      expect(accountIsFreeTierForModels('free', 'dev')).toBe(true);
    }
  });

  test('a paid tier is never blocked, in any environment', () => {
    for (const env of ['prod', 'staging', 'dev', 'preview']) {
      for (const name of PAID_TIER_NAMES) {
        expect(accountIsFreeTierForModels(name, env)).toBe(false);
      }
    }
  });
});
