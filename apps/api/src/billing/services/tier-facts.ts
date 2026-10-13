/**
 * The config-free half of the tier vocabulary.
 *
 * `tiers.ts` reaches for `../../config` at module scope (Stripe price catalogs
 * are per-environment), which means importing ANY symbol from it boots env
 * validation. These few facts are pure data/predicates with no environment
 * dependency, so they live here and `tiers.ts` re-exports them — one definition,
 * importable from a genuinely pure module (`billing-state.ts`) without dragging
 * in configuration.
 */

/** Minimum wallet balance, in dollars, required to admit one run. */
export const MINIMUM_CREDIT_FOR_RUN = 0.01;

/**
 * The four plan keys. Plans differ only in credit volume: `credits` is any
 * monthly amount, and the amount lives on the account, not in the key.
 */
export const PLAN_KEYS = ['none', 'free', 'credits', 'enterprise'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/**
 * Plan keys sold before credits-only billing (2026-10-14). Stored rows still
 * carry them until the rewrite runs; every reader resolves them to `credits`
 * through `canonicalTier`.
 */
export const LEGACY_PAID_PLAN_KEYS = [
  'pro',
  'per_seat',
  'starter',
  'team',
  'scale',
  'tier_2_20',
  'tier_6_50',
  'tier_12_100',
  'tier_25_200',
  'tier_50_400',
  'tier_125_800',
  'tier_200_1000',
  'tier_150_1200',
] as const;

/** The plan a stored tier key means today. Unknown keys fail closed to `none`. */
export function canonicalTier(tierName: string | null | undefined): PlanKey {
  const key = tierName ?? 'none';
  if ((PLAN_KEYS as readonly string[]).includes(key)) return key as PlanKey;
  if ((LEGACY_PAID_PLAN_KEYS as readonly string[]).includes(key)) return 'credits';
  return 'none';
}

/** Returns true if the tier is a paid tier (not free/none). */
export function isPaidTier(tierName: string): boolean {
  return tierName !== 'free' && tierName !== 'none';
}

/**
 * Legacy flat plans sold before compute metering existed. A row whose STORED
 * tier is still one of these does not pay for sandbox compute. The tier
 * rewrite to `credits` (after the customer notice) ends the exemption; there is
 * no other switch.
 */
export const LEGACY_PAID_TIERS_UNMETERED = [
  'tier_2_20',
  'tier_6_50',
  'tier_25_200',
  'tier_200_1000',
  'pro',
] as const;

/**
 * Does THIS ACCOUNT pay for sandbox compute? Every account with a credit row
 * does, except a stored legacy flat plan. Reads the RAW stored tier on purpose:
 * `canonicalTier` folds those keys into `credits`.
 */
export function accountRowMetersCompute(
  account: { tier?: string | null } | null | undefined,
): boolean {
  if (!account) return false;
  return !(LEGACY_PAID_TIERS_UNMETERED as readonly string[]).includes(account.tier ?? '');
}
