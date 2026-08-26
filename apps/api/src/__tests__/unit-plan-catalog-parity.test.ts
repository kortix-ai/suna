import { describe, expect, mock, test } from 'bun:test';

// Characterization test for the plan catalog (billing/services/plan-catalog.ts).
//
// The catalog is a SECOND SPELLING of facts that already live in `TIERS`
// (billing/services/tiers.ts) and the legacy multiplier table
// (shared/account-limits.ts). It exists so the billing refactor has one typed
// record per plan instead of a dozen ad-hoc derivations — but it is only safe
// while the two spellings agree exactly. This test is that guarantee: it walks
// EVERY key in TIERS and asserts the catalog record reproduces what today's
// helpers return. If someone edits one side, this goes red.
//
// No consumer is switched in this PR. The catalog and resolver land first,
// proven equivalent, and callers move afterwards.

// tiers.ts reads config.INTERNAL_KORTIX_ENV at module scope (per-environment
// Stripe price catalogs) and account-limits.ts reads the rate-limit budgets and
// the billing kill-switch. Stub both so the unit suite stays hermetic.
// The two rate budgets are deliberately chosen so the multiplier is recoverable
// from a policy limit with no ambiguity: 7 is not a multiple of 100, so
// `limit === 7` means and only means "multiplier 0 → free budget".
const FREE_REQS_PER_MIN = 7;
const PAID_REQS_PER_MIN = 100;

mock.module('../config', () => ({
  config: {
    INTERNAL_KORTIX_ENV: 'dev',
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    ENTERPRISE_LICENSE_AVAILABLE: false,
    KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: FREE_REQS_PER_MIN,
    KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: PAID_REQS_PER_MIN,
  },
}));

// account-limits.ts and entitlements.ts both reach the credit-account repo at
// import time. Nothing under test calls these; the stub only keeps the DB out.
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => null,
  getSubscriptionInfo: async () => null,
}));

const {
  getAllTiers,
  getTier,
  getTierEntitlements,
  getTierOrder,
  isValidTier,
  tierGrantsAllModels,
} = await import('../billing/services/tiers');
const { maxConcurrentSessionsForTier, sessionLlmPolicyForTier } = await import(
  '../shared/account-limits'
);
const { getPlanRecord, listPlanRecords, PLAN_CATALOG, PLAN_FAMILIES, resolvePlanRecord } =
  await import('../billing/services/plan-catalog');

/** The multiplier `tierMultiplier` applied, recovered from the emitted policy. */
function observedLlmMultiplier(tier: string): number {
  const { limit } = sessionLlmPolicyForTier(tier);
  return limit === FREE_REQS_PER_MIN ? 0 : limit / PAID_REQS_PER_MIN;
}

const TIER_KEYS = getAllTiers().map((t) => t.name);

describe('plan catalog covers exactly the tier vocabulary', () => {
  test('every TIERS key has a record, and the catalog adds none of its own', () => {
    expect([...TIER_KEYS].sort()).toEqual(Object.keys(PLAN_CATALOG).sort());
    // 16 keys: none, free, pro, per_seat, starter, team, scale, enterprise, and
    // the 8 legacy tier_N_M plans. Pinned so adding a tier without a plan record
    // (or the reverse) fails here rather than silently resolving to `none`.
    expect(TIER_KEYS).toHaveLength(16);
  });

  test('catalog membership is the same predicate as isValidTier', () => {
    for (const key of Object.keys(PLAN_CATALOG)) expect(isValidTier(key)).toBe(true);
    expect(getPlanRecord('not_a_tier')).toBeNull();
    expect(isValidTier('not_a_tier')).toBe(false);
  });

  test('record.key matches its catalog slot and TierConfig.name', () => {
    for (const key of TIER_KEYS) {
      expect(PLAN_CATALOG[key]?.key).toBe(key);
      expect(getTier(key).name).toBe(key);
    }
  });
});

// One describe block per tier key — a plain loop rather than describe.each so
// the assertions stay fully typed.
for (const key of TIER_KEYS) {
  describe(`plan record parity — ${key}`, () => {
    const record = PLAN_CATALOG[key] as NonNullable<(typeof PLAN_CATALOG)[string]>;
    const tier = getTier(key);

    test('displayName is exactly today’s displayName', () => {
      expect(record.displayName).toBe(tier.displayName);
    });

    test('price matches TierConfig.monthlyPrice', () => {
      expect(record.price.amountUsd).toBe(tier.monthlyPrice);
    });

    test('grant matches TierConfig.monthlyCredits', () => {
      expect(record.grant.includedCreditsUsd).toBe(tier.monthlyCredits);
    });

    test('canPurchaseCredits matches TierConfig.canPurchaseCredits', () => {
      expect(record.entitlements.canPurchaseCredits).toBe(tier.canPurchaseCredits);
    });

    test('enterprise entitlements match getTierEntitlements', () => {
      const expected = getTierEntitlements(key);
      expect({
        sso: record.entitlements.sso,
        scim: record.entitlements.scim,
        rbac: record.entitlements.rbac,
        auditAccess: record.entitlements.auditAccess,
        branding: record.entitlements.branding,
      }).toEqual(expected);
    });

    test('managedModels matches tierGrantsAllModels', () => {
      expect(record.entitlements.managedModels).toBe(tierGrantsAllModels(key));
    });

    test('concurrentSessions matches TierConfig.concurrentSessionLimit', () => {
      expect(record.limits.concurrentSessions).toBe(tier.concurrentSessionLimit);
      // …and therefore the number the limit layer actually enforces.
      expect(record.limits.concurrentSessions).toBe(maxConcurrentSessionsForTier(key));
    });

    test('llmRateMultiplier matches the multiplier sessionLlmPolicyForTier applies', () => {
      expect(record.limits.llmRateMultiplier).toBe(observedLlmMultiplier(key));
    });

    test('metersCompute is true only for the seat shape', () => {
      // accountMetersCompute() is billing_model-driven ('per_seat' | 'credit'),
      // so on a RECORD the only structurally implied case is shape 'seat'.
      expect(record.entitlements.metersCompute).toBe(record.shape === 'seat');
    });

    test('family is one of the three public families; compute multiplier is 1.0', () => {
      expect(PLAN_FAMILIES).toContain(record.family);
      expect(record.compute.rateMultiplier).toBe(1.0);
    });
  });
}

describe('rank is a strict ladder', () => {
  test('ranks are unique and dense from 0', () => {
    const ranks = listPlanRecords().map((r) => r.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i));
  });

  test('none is 0, free is 1, enterprise is last', () => {
    expect(PLAN_CATALOG.none?.rank).toBe(0);
    expect(PLAN_CATALOG.free?.rank).toBe(1);
    const maxRank = Math.max(...Object.values(PLAN_CATALOG).map((r) => r.rank));
    expect(PLAN_CATALOG.enterprise?.rank).toBe(maxRank);
  });

  test('rank strictly increases over getTierOrder’s known order', () => {
    // The exact order array in tiers.ts getTierOrder().
    const known = [
      'none',
      'free',
      'pro',
      'tier_2_20',
      'tier_6_50',
      'tier_12_100',
      'tier_25_200',
      'tier_50_400',
      'tier_125_800',
      'tier_200_1000',
      'tier_150_1200',
      'enterprise',
    ];
    // Guard the list itself against drift in getTierOrder.
    expect(known.map((k) => getTierOrder(k))).toEqual(known.map((_, i) => i));

    for (let i = 1; i < known.length; i++) {
      const prev = PLAN_CATALOG[known[i - 1] as string] as { rank: number };
      const curr = PLAN_CATALOG[known[i] as string] as { rank: number };
      expect(curr.rank).toBeGreaterThan(prev.rank);
    }
  });

  test('rank ascends with monthly price above free (enterprise excepted)', () => {
    const ladder = listPlanRecords().filter((r) => r.key !== 'none' && r.key !== 'enterprise');
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1] as { price: { amountUsd: number } };
      const curr = ladder[i] as { price: { amountUsd: number } };
      expect(curr.price.amountUsd).toBeGreaterThanOrEqual(prev.price.amountUsd);
    }
  });
});

describe('lookup helpers are total and fail-safe', () => {
  test('getPlanRecord returns the record for a known key', () => {
    expect(getPlanRecord('per_seat')?.key).toBe('per_seat');
  });

  test('getPlanRecord returns null for unknown / empty / null keys', () => {
    expect(getPlanRecord('nope')).toBeNull();
    expect(getPlanRecord('')).toBeNull();
    expect(getPlanRecord(null)).toBeNull();
    expect(getPlanRecord(undefined)).toBeNull();
  });

  test('resolvePlanRecord never throws and falls back to none — like getTier', () => {
    for (const key of ['nope', '', null, undefined]) {
      expect(resolvePlanRecord(key as string | null | undefined).key).toBe('none');
      // getTier() has the same fallback, which is the behavior being preserved.
      expect(getTier((key ?? '') as string).name).toBe('none');
    }
  });
});
