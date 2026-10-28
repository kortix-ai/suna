/**
 * One pure function that answers "what is this account's billing situation?"
 * from a single credit_accounts row: the billing plan it pays for, its
 * Enterprise state, and its entitlements after the per-feature overrides.
 * Entitlements, limits, and account state all read it through the cache in
 * `billing-cache.ts`, so no surface re-derives part of the answer.
 *
 * The model is specified in .agents/skills/billing/references/plans-and-access.md:
 * money (the billing plan) and features (Enterprise: off | demo | licensed) are
 * separate, and `entitlement_overrides` is the one exception mechanism.
 *
 * PURE, and deliberately so — it takes the row, not an accountId, and returns a
 * value with no I/O, no clock of its own, and no cache.
 */

import { ENTITLEMENT_OVERRIDE_KEYS, readOverride } from './entitlement-overrides';
import { PLAN_FAMILY_LABELS, type PlanRecord, resolvePlanRecord } from './plan-catalog';
import { pickEnterprise } from '../../types';

/** The credit_accounts columns this resolver reads. */
export interface BillingRow {
  tier?: string | null;
  /** Licensed: an active Enterprise license contract. */
  enterpriseEntitled?: boolean | null;
  /** Demo: the account turned the Enterprise demo on itself. */
  demoEnterprise?: boolean | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  /**
   * `credit_accounts.entitlement_overrides` — the JSONB override map, each
   * entry optionally expiring. `unknown` because it is operator-written data
   * the parser must not trust; see `entitlement-overrides.ts`.
   */
  entitlementOverrides?: unknown;
}

/** Where the billing plan came from. */
export type BillingPlanSource = 'no_account' | 'stored';

/** The Enterprise feature layer. */
export type EnterpriseState = 'off' | 'demo' | 'licensed';

/** Sign-in access kept after an Enterprise license ends, so nobody is locked out. */
export interface AccessGrace {
  reason: 'contract_ended';
  endsAt: string;
}

export interface ResolvedBilling {
  /** The BILLING plan: what the account pays for (Free or Credits). */
  plan: PlanRecord;
  /** The plan whose LIMITS apply: Enterprise when licensed, else the billing plan. */
  features: PlanRecord;
  /** The Enterprise feature layer. */
  enterprise: EnterpriseState;
  source: BillingPlanSource;
  /** Plan entitlements, plus the Enterprise features for Demo or Licensed, then overrides. */
  entitlements: PlanRecord['entitlements'];
  /** Kept for the account-state shape; license grace is carried by overrides. */
  grace: AccessGrace | null;
  /** Customer-facing naming of the billing plan. */
  display: { label: string; sublabel: string | null };
}

/** SSO and SCIM stay on this long after an Enterprise license ends. */
export const ACCESS_GRACE_DAYS = 14;

function displayFor(plan: PlanRecord): { label: string; sublabel: string | null } {
  return { label: PLAN_FAMILY_LABELS[plan.family], sublabel: null };
}

/** The Enterprise state a row carries. A legacy `tier='enterprise'` row reads as licensed. */
export function enterpriseStateOf(row: BillingRow | null | undefined): EnterpriseState {
  if (!row) return 'off';
  if (row.enterpriseEntitled === true || row.tier === 'enterprise') return 'licensed';
  if (row.demoEnterprise === true) return 'demo';
  return 'off';
}

/**
 * THE managed-models invariant: Kortix-managed inference is sold, never given
 * away. Only a paid billing plan or a licensed Enterprise contract carries it.
 * Free and No Plan never do, whatever the catalog, an override or the
 * Enterprise demo says (2026-10-19: Free ran managed models on its included
 * credits through three separate exemptions).
 */
export function paysForManagedModels(plan: PlanRecord, enterprise: EnterpriseState): boolean {
  return plan.family !== 'free' || enterprise === 'licensed';
}

/**
 * Resolve the account's billing plan, Enterprise state and effective
 * entitlements from one row.
 *
 *   plan         stored tier (legacy keys → `credits`; a legacy `enterprise`
 *                tier → `credits`, its license read from the tier)
 *   enterprise   licensed (enterprise_entitled) > demo (demo_enterprise) > off
 *   entitlements plan → + Enterprise features (Demo, Licensed) → + Enterprise
 *                limits and no BYOK fee (Licensed only) → per-key overrides
 */
export function resolveBillingFromRow(
  row: BillingRow | null | undefined,
  nowMs: number = Date.now(),
): ResolvedBilling {
  if (!row) {
    const plan = resolvePlanRecord('none');
    return {
      plan,
      features: plan,
      enterprise: 'off',
      source: 'no_account',
      entitlements: { ...plan.entitlements },
      grace: null,
      display: displayFor(plan),
    };
  }

  // A row with no tier reads as 'none', not 'free'.
  const stored = resolvePlanRecord(row.tier === 'enterprise' ? 'credits' : (row.tier ?? 'none'));
  const enterprise = enterpriseStateOf(row);
  const licensed = resolvePlanRecord('enterprise');
  const features = enterprise === 'licensed' ? licensed : stored;

  const entitlements: PlanRecord['entitlements'] = { ...stored.entitlements };
  if (enterprise !== 'off') {
    Object.assign(entitlements, pickEnterprise(licensed.entitlements));
  }
  if (enterprise === 'licensed') Object.assign(entitlements, licensed.entitlements);

  for (const key of ENTITLEMENT_OVERRIDE_KEYS) {
    const value = readOverride(row.entitlementOverrides, key, nowMs);
    if (value !== undefined) entitlements[key] = value;
  }
  // Applied last, so no catalog row, override or demo can undo it.
  if (!paysForManagedModels(stored, enterprise)) entitlements.managedModels = false;

  return { plan: stored, features, enterprise, source: 'stored', entitlements, grace: null, display: displayFor(stored) };
}
