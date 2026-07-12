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

// Regression covered here (2026-07-05): dev-api.kortix.com and the pr-4145
// preview both 400 "No upstream configured for model glm-5.2" on every agent
// turn — traced to gateway_request_logs showing a same-day 'free' tier signup
// hitting the managed-model gate (`resolveCandidates` returns [] whenever
// `accountIsFreeTierForModels` is true), while paid-tier dev accounts succeed
// against the SAME openrouter/bedrock upstreams in the same window — i.e. the
// upstream config was never the problem, only entitlement. Every fresh
// dev/preview signup defaults to 'free', so without an exemption NO ONE could
// exercise managed-model chat on those QA surfaces. `tierGrantsAllModels`
// itself stays a pure function of tier config (see above) — the dev/preview
// carve-out lives only in this wrapper, which every gateway/picker call site
// now goes through instead of inlining `!tierGrantsAllModels`.
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

  test('dev/preview (explicit env arg): free and none tiers are NOT paywalled from managed models', () => {
    for (const env of ['dev', 'preview']) {
      expect(accountIsFreeTierForModels('free', env)).toBe(false);
      expect(accountIsFreeTierForModels('none', env)).toBe(false);
    }
  });

  test('prod/staging (explicit env arg): free and none tiers STAY paywalled', () => {
    for (const env of ['prod', 'staging']) {
      expect(accountIsFreeTierForModels('free', env)).toBe(true);
      expect(accountIsFreeTierForModels('none', env)).toBe(true);
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
