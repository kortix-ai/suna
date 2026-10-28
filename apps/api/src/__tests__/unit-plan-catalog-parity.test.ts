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
    KORTIX_LICENSE_KEY: '',
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
  LEGACY_PAID_PLAN_KEYS,
  PLAN_KEYS,
  canonicalTier,
  getTier,
  getTierEntitlements,
  isValidTier,
  tierGrantsAllModels,
} = await import('../billing/services/tiers');
const { sessionLlmPolicyForTier } = await import(
  '../shared/account-limits'
);
const { getPlanRecord, PLAN_CATALOG, resolvePlanRecord } =
  await import('../billing/services/plan-catalog');

/** The multiplier `tierMultiplier` applied, recovered from the emitted policy. */
function observedLlmMultiplier(tier: string): number {
  const { limit } = sessionLlmPolicyForTier(tier);
  return limit === FREE_REQS_PER_MIN ? 0 : limit / PAID_REQS_PER_MIN;
}

const TIER_KEYS: string[] = [...PLAN_KEYS];

describe('plan catalog covers exactly the tier vocabulary', () => {
  test('every TIERS key has a record, and the catalog adds none of its own', () => {
    expect([...TIER_KEYS].sort()).toEqual(Object.keys(PLAN_CATALOG).sort());
    // 4 keys: none, free, credits, enterprise. Every other stored key is a
    // legacy alias of `credits`. Pinned so adding a tier without a plan record
    // (or the reverse) fails here rather than silently resolving to `none`.
    expect(TIER_KEYS).toEqual(['none', 'free', 'credits', 'enterprise']);
    expect(TIER_KEYS).toHaveLength(4);
  });

  test('every legacy plan key resolves to the credits record, tier and entitlements', () => {
    for (const key of LEGACY_PAID_PLAN_KEYS) {
      expect(canonicalTier(key)).toBe('credits');
      expect(getPlanRecord(key)).toBe(PLAN_CATALOG.credits as NonNullable<typeof PLAN_CATALOG.credits>);
      expect(resolvePlanRecord(key).key).toBe('credits');
      expect(getTier(key).name).toBe('credits');
      expect(observedLlmMultiplier(key)).toBe(12);
    }
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
      }).toEqual(expected);
    });

    test('branding is on for every plan', () => {
      expect(record.entitlements.branding).toBe(true);
    });

    test('managedModels matches tierGrantsAllModels', () => {
      expect(record.entitlements.managedModels).toBe(tierGrantsAllModels(key));
    });

    test('the catalog limits carry only llmRateMultiplier — no session cap', () => {
      expect(Object.keys(record.limits)).toEqual(['llmRateMultiplier']);
    });

    test('llmRateMultiplier matches the multiplier sessionLlmPolicyForTier applies', () => {
      expect(record.limits.llmRateMultiplier).toBe(observedLlmMultiplier(key));
    });

    test('family is one of the public families', () => {
      expect(['free', 'credits', 'enterprise']).toContain(record.family);
    });
  });
}

describe('rank is a strict ladder', () => {
  test('ranks are unique and dense from 0', () => {
    const ranks = Object.values(PLAN_CATALOG).sort((a, b) => a.rank - b.rank).map((r) => r.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i));
  });

  test('none is 0, free is 1, enterprise is last', () => {
    expect(PLAN_CATALOG.none?.rank).toBe(0);
    expect(PLAN_CATALOG.free?.rank).toBe(1);
    const maxRank = Math.max(...Object.values(PLAN_CATALOG).map((r) => r.rank));
    expect(PLAN_CATALOG.enterprise?.rank).toBe(maxRank);
  });

  test('rank strictly increases over none, free, credits, enterprise', () => {
    const known = ['none', 'free', 'credits', 'enterprise'];
    for (let i = 1; i < known.length; i++) {
      const prev = PLAN_CATALOG[known[i - 1] as string] as { rank: number };
      const curr = PLAN_CATALOG[known[i] as string] as { rank: number };
      expect(curr.rank).toBeGreaterThan(prev.rank);
    }
  });
});

describe('lookup helpers are total and fail-safe', () => {
  test('getPlanRecord returns the record for a known key', () => {
    expect(getPlanRecord('credits')?.key).toBe('credits');
    // A legacy key resolves to the credits record.
    expect(getPlanRecord('per_seat')?.key).toBe('credits');
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
