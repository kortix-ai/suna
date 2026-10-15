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

/** Where the billing plan came from. ('trial' is retired: trials are removed.) */
export type BillingPlanSource = 'no_account' | 'trial' | 'stored';

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

/** Trials are removed. Kept so an old import resolves; never active. */
export function trialIsActive(_row: BillingRow, _nowMs: number): boolean {
  return false;
}

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
    const { sso, scim, rbac, auditAccess, branding } = licensed.entitlements;
    Object.assign(entitlements, { sso, scim, rbac, auditAccess, branding });
  }
  if (enterprise === 'licensed') Object.assign(entitlements, licensed.entitlements);

  for (const key of ENTITLEMENT_OVERRIDE_KEYS) {
    const value = readOverride(row.entitlementOverrides, key, nowMs);
    if (value !== undefined) entitlements[key] = value;
  }

  return { plan: stored, features, enterprise, source: 'stored', entitlements, grace: null, display: displayFor(stored) };
}
