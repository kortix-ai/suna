/**
 * The plan catalog — one record per plan key, describing the plan the way the
 * product talks about it (family, shape, entitlements, limits) rather than the
 * way `TierConfig` stores it.
 *
 * PURE. Like `tier-facts.ts`, this module must never import `../../config` (or
 * anything that reaches it — `tiers.ts` builds per-environment Stripe price
 * catalogs at module scope). Everything here is static data plus total
 * functions over it.
 *
 * Four keys. Plans differ only in credit volume: every paid account is on
 * `credits` at the monthly amount it chose. Legacy stored keys resolve through
 * `canonicalTier` (tier-facts.ts). `unit-plan-catalog-parity.test.ts` pins this
 * table to `TIERS` in tiers.ts.
 */

import { canonicalTier } from './tier-facts';

/** Public plan family — the identity a customer sees. */
export type PlanFamily = 'free' | 'credits' | 'enterprise';

/**
 * Lifecycle of a plan key.
 *   current  — sellable today.
 *   non_plan — the absence of a plan (`none`).
 */
export type PlanStatus = 'current' | 'non_plan';

/** How the recurring charge is computed. */
export type BillingShape = 'none' | 'credits' | 'contract';

export interface PlanRecord {
  key: string;
  family: PlanFamily;
  status: PlanStatus;
  shape: BillingShape;
  /** Strictly ordered ladder position. Compare, don't display. */
  rank: number;
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
  };
  limits: {
    /**
     * LLM router rate multiplier. 0 selects the FREE requests-per-minute
     * budget instead of paid × multiplier. `credits` carries 12, the highest
     * any legacy paid plan had: spend is capped by credits, not by the plan.
     */
    llmRateMultiplier: number;
  };
  /** EXACTLY `TierConfig.displayName`. */
  displayName: string;
}

/** Customer-facing name of each family. */
export const PLAN_FAMILY_LABELS: Record<PlanFamily, string> = {
  free: 'Free',
  credits: 'Credits',
  enterprise: 'Enterprise',
};

const NO_ENTERPRISE = {
  sso: false,
  scim: false,
  rbac: false,
  auditAccess: false,
  branding: false,
} as const;

export const PLAN_CATALOG: Record<string, PlanRecord> = {
  none: {
    key: 'none',
    family: 'free',
    status: 'non_plan',
    shape: 'none',
    rank: 0,
    entitlements: { ...NO_ENTERPRISE, managedModels: false, canPurchaseCredits: false },
    limits: { llmRateMultiplier: 0 },
    displayName: 'No Plan',
  },

  // $2 (200 credits) a month. Sandbox compute spends them; managed models stay
  // gated — except the platform default, which every tier may run (KRTX-1067).
  free: {
    key: 'free',
    family: 'free',
    status: 'current',
    shape: 'none',
    rank: 1,
    entitlements: { ...NO_ENTERPRISE, managedModels: false, canPurchaseCredits: false },
    limits: { llmRateMultiplier: 0 },
    displayName: 'Free',
  },

  credits: {
    key: 'credits',
    family: 'credits',
    status: 'current',
    shape: 'credits',
    rank: 2,
    entitlements: { ...NO_ENTERPRISE, managedModels: true, canPurchaseCredits: true },
    limits: { llmRateMultiplier: 12 },
    displayName: 'Credits',
  },

  // Sales-assigned. Credits are granted per contract.
  enterprise: {
    key: 'enterprise',
    family: 'enterprise',
    status: 'current',
    shape: 'contract',
    rank: 3,
    entitlements: {
      sso: true,
      scim: true,
      rbac: true,
      auditAccess: true,
      branding: true,
      managedModels: true,
      canPurchaseCredits: true,
    },
    limits: { llmRateMultiplier: 12 },
    displayName: 'Enterprise',
  },
};

/** The record used whenever a key cannot be resolved. */
export const NO_PLAN: PlanRecord = PLAN_CATALOG.none as PlanRecord;

/**
 * Lookup for a STORED key, legacy keys included. Returns null only for a key
 * that is neither current nor legacy — use this to TEST a key.
 */
export function getPlanRecord(key: string | null | undefined): PlanRecord | null {
  if (!key) return null;
  const canonical = canonicalTier(key);
  if (canonical === 'none' && key !== 'none') return null;
  return PLAN_CATALOG[canonical] ?? null;
}

/**
 * Total lookup. An unknown, empty, or null key resolves to the `none` record.
 * Fail-safe by construction: never throws, and the fallback grants nothing —
 * same convention as `getTier()`.
 */
export function resolvePlanRecord(key: string | null | undefined): PlanRecord {
  return getPlanRecord(key) ?? NO_PLAN;
}
