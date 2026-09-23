/**
 * Plan logic for the Plans screen (components/settings/PlanPage.tsx) and the
 * upgrade sheet. Pure functions, tested in plan-action.test.mts.
 */

import type { PricingPlanId } from './pricing';

/** What an account behaves as, independent of its stored tier key. */
export type PlanFamily = 'free' | 'team' | 'enterprise';

/** The account-state fields the family is read from. */
export interface PlanFamilySource {
  plan?: { family?: string | null } | null;
  subscription?: { tier_key?: string | null } | null;
  tier?: { name?: string | null } | null;
}

/**
 * Mirrors `resolvedPlan(state).family` in `@kortix/sdk`
 * (packages/sdk/src/core/rest/projects-client/billing.ts): the API's `plan`
 * block wins, because the stored `tier_key` stays `free` for an admin trial
 * and for a per-seat team whose row is stale. Older APIs without `plan` fall
 * back to the tier key: `free` / `none` / empty → free, `enterprise` →
 * enterprise, any other key (per-seat team, grandfathered tiers) → team.
 */
export function getPlanFamily(state: PlanFamilySource | null | undefined): PlanFamily {
  const family = state?.plan?.family;
  if (family === 'free' || family === 'team' || family === 'enterprise') return family;

  const key = (state?.subscription?.tier_key || state?.tier?.name || 'none').trim().toLowerCase();
  if (key === '' || key === 'free' || key === 'none') return 'free';
  if (key === 'enterprise') return 'enterprise';
  return 'team';
}

const FAMILY_OF_PLAN: Record<PricingPlanId, PlanFamily> = {
  free: 'free',
  team: 'team',
  enterprise: 'enterprise',
};

/** True when the plan card describes the plan the account is on. */
export function isCurrentPlan(planId: PricingPlanId, current: PlanFamily): boolean {
  return FAMILY_OF_PLAN[planId] === current;
}

/** The plan selected when the Plans screen opens: one step up from Free, else the current plan. */
export function defaultPlanSelection(current: PlanFamily): PricingPlanId {
  return current === 'free' ? 'team' : current;
}

/**
 * What the Plans screen's button does for the selected plan.
 * - `current`: the account is on it — disabled "Current plan".
 * - `contact-sales`: Enterprise — opens the web contact page.
 * - `ask-owner`: the user cannot manage billing — disabled.
 * - `upgrade`: Free → Team — opens web billing.
 * - `switch`: a paid plan → Free — opens web billing.
 */
export type PlanAction = 'current' | 'contact-sales' | 'ask-owner' | 'upgrade' | 'switch';

export function getPlanAction({
  selected,
  current,
  canManageBilling,
}: {
  selected: PricingPlanId;
  current: PlanFamily;
  canManageBilling: boolean;
}): PlanAction {
  if (isCurrentPlan(selected, current)) return 'current';
  if (selected === 'enterprise') return 'contact-sales';
  if (!canManageBilling) return 'ask-owner';
  return selected === 'team' ? 'upgrade' : 'switch';
}
