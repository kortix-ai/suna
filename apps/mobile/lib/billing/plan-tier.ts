/**
 * The plan family of the API's plan label. Drives the plan ring around the
 * drawer avatar.
 *
 * The API's `plan.label` is the family name (`PLAN_FAMILY_LABELS`,
 * apps/api/src/billing/services/plan-catalog.ts): "Free", "Team", or
 * "Enterprise". Every tier key, current or grandfathered, displays under one
 * of the three. Legacy tier names (Plus, Pro, Ultra, …) are not read
 * (Jay, 2026-09-23).
 */
export type PlanTier = 'free' | 'team' | 'enterprise';

const TIERS: Record<string, PlanTier> = { free: 'free', team: 'team', enterprise: 'enterprise' };

export function planTier(planLabel: string | null | undefined): PlanTier | null {
  return TIERS[planLabel?.trim().toLowerCase() ?? ''] ?? null;
}
