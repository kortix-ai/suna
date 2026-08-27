/**
 * The plan catalog — one record per billable plan key, describing the plan the
 * way the product talks about it (family, status, billing shape, price, grant,
 * entitlements, limits) rather than the way `TierConfig` happens to store it.
 *
 * PURE. Like `tier-facts.ts`, this module must never import `../../config` (or
 * anything that reaches it — `tiers.ts` builds per-environment Stripe price
 * catalogs at module scope, so importing ANY symbol from it boots env
 * validation). Everything here is static data plus total functions over it.
 *
 * PARITY CONTRACT. Every number below is transcribed from `TIERS` in `tiers.ts`
 * and the legacy multiplier table in `shared/account-limits.ts`. It is a second
 * spelling of today's behavior, NOT a redefinition of it.
 * `src/__tests__/unit-plan-catalog-parity.test.ts` asserts the two agree for all
 * 16 keys and fails the build if they ever drift.
 *
 * NOTHING CONSUMES THIS YET. The catalog and `resolve-billing.ts` land first so
 * the parity test can prove them equivalent before any consumer is switched.
 */

/**
 * Public plan family — the identity a customer sees. There are exactly three
 * rungs on the public ladder: Free, Team, Enterprise. Grandfathered and retired
 * plans still belong to a family (that is how they are LABELLED); they keep
 * their own prices, grants, and limits.
 */
export type PlanFamily = 'free' | 'team' | 'enterprise';

/**
 * Lifecycle of a plan key.
 *   current       — sellable today.
 *   grandfathered — sold once, still honored exactly as sold, not offered.
 *   retired       — defined but never sold (no Stripe price ever existed).
 *   non_plan      — the absence of a plan (`none`).
 */
export type PlanStatus = 'current' | 'grandfathered' | 'retired' | 'non_plan';

/** How the recurring charge is computed. */
export type BillingShape = 'none' | 'flat' | 'seat' | 'contract';

export interface PlanRecord {
  key: string;
  family: PlanFamily;
  status: PlanStatus;
  shape: BillingShape;
  /** Strictly ordered ladder position. See RANKING below. */
  rank: number;
  price: { amountUsd: number; unit: 'month' | 'seat_month' | 'contract' };
  grant: { includedCreditsUsd: number; per: 'account' | 'seat' };
  entitlements: {
    sso: boolean;
    scim: boolean;
    rbac: boolean;
    auditAccess: boolean;
    /** Organization branding (own logo / icon / favicon / product name). */
    branding: boolean;
    /** True iff the tier's `models` list includes 'all' (tierGrantsAllModels). */
    managedModels: boolean;
    canPurchaseCredits: boolean;
    /**
     * Does an account on this plan pay for sandbox compute?
     *
     * Today this is NOT a property of the plan — `accountMetersCompute` in
     * `tier-facts.ts` reads `credit_accounts.billing_model` ('per_seat' |
     * 'credit'), a column, not the tier. The only plan key whose billing_model
     * is structurally implied is `per_seat`, so on a RECORD this is true iff
     * `shape === 'seat'`. A flat v3 credit plan meters compute because its ROW
     * carries billing_model='credit', which the record cannot know — the
     * resolver takes the row, so that mapping belongs there when a consumer
     * needs it, not here.
     */
    metersCompute: boolean;
  };
  limits: {
    concurrentSessions: number;
    /**
     * LLM router rate multiplier, transcribed from `tierMultiplier` in
     * `shared/account-limits.ts`. NOTE: free/none are 0, not 1 — a 0 multiplier
     * selects the FREE requests-per-minute budget instead of paid × multiplier.
     */
    llmRateMultiplier: number;
  };
  /** Reserved for per-plan compute pricing. 1.0 everywhere today. */
  compute: { rateMultiplier: number };
  /** EXACTLY `TierConfig.displayName` — parity, not a new label. */
  displayName: string;
}

/** Public ladder, low to high. */
export const PLAN_FAMILIES: readonly PlanFamily[] = ['free', 'team', 'enterprise'] as const;

/** Customer-facing name of each family. */
export const PLAN_FAMILY_LABELS: Record<PlanFamily, string> = {
  free: 'Free',
  team: 'Team',
  enterprise: 'Enterprise',
};

const NO_ENTERPRISE = {
  sso: false,
  scim: false,
  rbac: false,
  auditAccess: false,
  branding: false,
} as const;
const ALL_ENTERPRISE = {
  sso: true,
  scim: true,
  rbac: true,
  auditAccess: true,
  branding: true,
} as const;

// ─── RANKING ────────────────────────────────────────────────────────────────
// rank 0 = none, rank 1 = free, then ascending monthly price, enterprise last.
// Ties at equal price break so that (a) non-legacy plan keys precede legacy
// `tier_*` keys and (b) otherwise alphabetically. That rule reproduces
// `getTierOrder()`'s relative order for every key that appears in it, which the
// parity test asserts:
//   none < free < pro < tier_2_20 < tier_6_50 < tier_12_100 < tier_25_200
//        < tier_50_400 < tier_125_800 < tier_200_1000 < tier_150_1200 < enterprise
// $20: pro, tier_2_20 · $40: per_seat, starter · $200: team, tier_25_200
// $800: scale, tier_125_800

export const PLAN_CATALOG: Record<string, PlanRecord> = {
  // ─── Free family ──────────────────────────────────────────────────────────
  none: {
    key: 'none',
    family: 'free',
    status: 'non_plan',
    shape: 'none',
    rank: 0,
    price: { amountUsd: 0, unit: 'month' },
    grant: { includedCreditsUsd: 0, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: false,
      canPurchaseCredits: false,
      metersCompute: false,
    },
    limits: { concurrentSessions: 50, llmRateMultiplier: 0 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'No Plan',
  },

  free: {
    key: 'free',
    family: 'free',
    status: 'current',
    shape: 'none',
    rank: 1,
    price: { amountUsd: 0, unit: 'month' },
    // $2 of expiring sandbox-only credits — sandbox-only because
    // managedModels is false, not because the wallet is partitioned.
    grant: { includedCreditsUsd: 2, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: false,
      canPurchaseCredits: false,
      metersCompute: false,
    },
    limits: { concurrentSessions: 50, llmRateMultiplier: 0 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Free',
  },

  // ─── Team family ──────────────────────────────────────────────────────────
  // Grandfathered individual/small plans. There is no separate "starter"
  // family: the public ladder is free / team / enterprise, and a grandfathered
  // key keeps its own numbers while displaying under its family's name.
  pro: {
    key: 'pro',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 2,
    price: { amountUsd: 20, unit: 'month' },
    // No monthly credits — $5 one-time per machine provisioned.
    grant: { includedCreditsUsd: 0, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 200, llmRateMultiplier: 1 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Pro',
  },

  tier_2_20: {
    key: 'tier_2_20',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 3,
    price: { amountUsd: 20, unit: 'month' },
    grant: { includedCreditsUsd: 20, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 200, llmRateMultiplier: 1 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Plus (Legacy)',
  },

  // Billing v2 seat plan. The record models ONE seat: price is per seat-month
  // and the grant is per seat (multi-seat math is grantForSeats() in tiers.ts).
  // The only shape that structurally meters compute.
  per_seat: {
    key: 'per_seat',
    family: 'team',
    status: 'grandfathered',
    shape: 'seat',
    rank: 4,
    price: { amountUsd: 40, unit: 'seat_month' },
    grant: { includedCreditsUsd: 25, per: 'seat' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: true,
    },
    limits: { concurrentSessions: 200, llmRateMultiplier: 1 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Team (legacy seats)',
  },

  // Billing v3 flat credit plans. Defined, never sold — no Stripe price exists
  // for any of them, so getVisibleTiers() has always filtered them out and no
  // account can carry one. Retired, not current.
  starter: {
    key: 'starter',
    family: 'team',
    status: 'retired',
    shape: 'flat',
    rank: 5,
    price: { amountUsd: 40, unit: 'month' },
    grant: { includedCreditsUsd: 25, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: false,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 3, llmRateMultiplier: 1 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Starter',
  },

  tier_6_50: {
    key: 'tier_6_50',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 6,
    price: { amountUsd: 50, unit: 'month' },
    grant: { includedCreditsUsd: 50, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 300, llmRateMultiplier: 2 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Pro (Legacy)',
  },

  tier_12_100: {
    key: 'tier_12_100',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 7,
    price: { amountUsd: 100, unit: 'month' },
    grant: { includedCreditsUsd: 100, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 400, llmRateMultiplier: 3 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Business (Legacy)',
  },

  team: {
    key: 'team',
    family: 'team',
    status: 'retired',
    shape: 'flat',
    rank: 8,
    price: { amountUsd: 200, unit: 'month' },
    grant: { includedCreditsUsd: 125, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: false,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 10, llmRateMultiplier: 1 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Team',
  },

  tier_25_200: {
    key: 'tier_25_200',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 9,
    price: { amountUsd: 200, unit: 'month' },
    grant: { includedCreditsUsd: 200, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 500, llmRateMultiplier: 4 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Ultra (Legacy)',
  },

  tier_50_400: {
    key: 'tier_50_400',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 10,
    price: { amountUsd: 400, unit: 'month' },
    grant: { includedCreditsUsd: 400, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 750, llmRateMultiplier: 6 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Enterprise (Legacy)',
  },

  scale: {
    key: 'scale',
    family: 'team',
    status: 'retired',
    shape: 'flat',
    rank: 11,
    price: { amountUsd: 800, unit: 'month' },
    grant: { includedCreditsUsd: 500, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: false,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 30, llmRateMultiplier: 1 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Scale',
  },

  tier_125_800: {
    key: 'tier_125_800',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 12,
    price: { amountUsd: 800, unit: 'month' },
    grant: { includedCreditsUsd: 800, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 1000, llmRateMultiplier: 8 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Scale (Legacy)',
  },

  tier_200_1000: {
    key: 'tier_200_1000',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 13,
    price: { amountUsd: 1000, unit: 'month' },
    grant: { includedCreditsUsd: 1000, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 1500, llmRateMultiplier: 10 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Max (Legacy)',
  },

  tier_150_1200: {
    key: 'tier_150_1200',
    family: 'team',
    status: 'grandfathered',
    shape: 'flat',
    rank: 14,
    price: { amountUsd: 1200, unit: 'month' },
    grant: { includedCreditsUsd: 1200, per: 'account' },
    entitlements: {
      ...NO_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 2000, llmRateMultiplier: 12 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Enterprise Max (Legacy)',
  },

  // ─── Enterprise family ────────────────────────────────────────────────────
  // Sales-assigned. Price and credits are negotiated out-of-band, which is why
  // both are 0 in the tier config — the contract, not the catalog, carries them.
  enterprise: {
    key: 'enterprise',
    family: 'enterprise',
    status: 'current',
    shape: 'contract',
    rank: 15,
    price: { amountUsd: 0, unit: 'contract' },
    grant: { includedCreditsUsd: 0, per: 'account' },
    entitlements: {
      ...ALL_ENTERPRISE,
      managedModels: true,
      canPurchaseCredits: true,
      metersCompute: false,
    },
    limits: { concurrentSessions: 5000, llmRateMultiplier: 1 },
    compute: { rateMultiplier: 1.0 },
    displayName: 'Enterprise',
  },
};

/** The record used whenever a key cannot be resolved. */
export const NO_PLAN: PlanRecord = PLAN_CATALOG.none as PlanRecord;

/** Exact lookup. Returns null for an unknown key — use this to TEST a key. */
export function getPlanRecord(key: string | null | undefined): PlanRecord | null {
  if (!key) return null;
  return PLAN_CATALOG[key] ?? null;
}

/**
 * Total lookup. An unknown, empty, or null key resolves to the `none` record.
 * Fail-safe by construction: never throws, and the fallback grants nothing —
 * same convention as `getTier()`.
 */
export function resolvePlanRecord(key: string | null | undefined): PlanRecord {
  return getPlanRecord(key) ?? NO_PLAN;
}

/** Every key in the catalog, in rank order. */
export function listPlanRecords(): PlanRecord[] {
  return Object.values(PLAN_CATALOG).sort((a, b) => a.rank - b.rank);
}
