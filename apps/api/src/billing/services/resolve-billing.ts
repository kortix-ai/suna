/**
 * One pure function that answers "what is this account's billing situation?"
 * from a single credit_accounts row: the plan it behaves as (trial overlay),
 * and its entitlements after the grace window and the per-feature overrides.
 * Entitlements, limits, and account state all read it through the cache in
 * `billing-cache.ts`, so no surface re-derives part of the answer.
 *
 * The model is specified in .agents/skills/billing/references/plans-and-access.md:
 * the plan decides features, a trial is a dated grant of a plan, and
 * `entitlement_overrides` is the one exception mechanism.
 *
 * PURE, and deliberately so — it takes the row, not an accountId, and returns a
 * value with no I/O, no clock of its own, and no cache.
 */

import { ENTITLEMENT_OVERRIDE_KEYS, readOverride } from './entitlement-overrides';
import {
  PLAN_FAMILY_LABELS,
  type PlanRecord,
  getPlanRecord,
  resolvePlanRecord,
} from './plan-catalog';

/** The credit_accounts columns this resolver reads. */
export interface BillingRow {
  tier?: string | null;
  trialStatus?: string | null;
  trialTier?: string | null;
  trialEndsAt?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  /**
   * `credit_accounts.entitlement_overrides` — the JSONB override map, each
   * entry optionally expiring. `unknown` because it is operator-written data
   * the parser must not trust; see `entitlement-overrides.ts`.
   */
  entitlementOverrides?: unknown;
}

/** Where the resolved plan came from. */
export type BillingPlanSource = 'no_account' | 'trial' | 'stored';

/** Sign-in access kept after an Enterprise trial ends, so nobody is locked out. */
export interface AccessGrace {
  reason: 'trial_ended';
  endsAt: string;
}

export interface ResolvedBilling {
  /**
   * The BILLING plan: what the account pays for, and how. A Credits trial lends
   * it; an Enterprise trial does not, so a trialing account can still pick and
   * pay for a plan.
   */
  plan: PlanRecord;
  /**
   * The plan whose features and limits apply: the billing plan, or Enterprise
   * during an Enterprise trial. Gates read this, display reads `plan`.
   */
  features: PlanRecord;
  /** 'trial' while an active trial lends the plan or its features. */
  source: BillingPlanSource;
  /** Plan entitlements with the grace window and the per-feature overrides applied. */
  entitlements: PlanRecord['entitlements'];
  /** Set while SSO/SCIM stay on after an Enterprise trial ended. */
  grace: AccessGrace | null;
  /** Customer-facing naming. */
  display: { label: string; sublabel: string | null };
}

const TRIAL_STATUS_ACTIVE = 'active';
const TRIAL_STATUS_EXPIRED = 'expired';

/** SSO and SCIM stay on this long after an Enterprise trial or contract ends. */
export const ACCESS_GRACE_DAYS = 14;
const ACCESS_GRACE_MS = ACCESS_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Whether the row carries a currently-granting trial. Expiry is LAZY: a trial
 * stops granting the instant `trial_ends_at` passes, whether or not the sweep
 * has flipped `trial_status` yet.
 */
export function trialIsActive(row: BillingRow, nowMs: number): boolean {
  if (row.trialStatus !== TRIAL_STATUS_ACTIVE) return false;
  if (!row.trialTier || !getPlanRecord(row.trialTier)) return false;
  if (!row.trialEndsAt) return false;
  const endsAt = new Date(row.trialEndsAt).getTime();
  return Number.isFinite(endsAt) && endsAt > nowMs;
}

/**
 * The grace window after an Enterprise trial ran out (not after a revoke: a
 * revoke is deliberate). Lazy, like expiry, so the hour before the sweep runs
 * cannot lock anyone out.
 */
function trialGrace(row: BillingRow, nowMs: number): AccessGrace | null {
  if (row.trialStatus !== TRIAL_STATUS_ACTIVE && row.trialStatus !== TRIAL_STATUS_EXPIRED) return null;
  if (!row.trialTier || resolvePlanRecord(row.trialTier).family !== 'enterprise') return null;
  if (!row.trialEndsAt) return null;
  const endedMs = new Date(row.trialEndsAt).getTime();
  if (!Number.isFinite(endedMs) || endedMs > nowMs) return null;
  const graceEndsMs = endedMs + ACCESS_GRACE_MS;
  return graceEndsMs > nowMs ? { reason: 'trial_ended', endsAt: new Date(graceEndsMs).toISOString() } : null;
}

function displayFor(plan: PlanRecord): { label: string; sublabel: string | null } {
  return { label: PLAN_FAMILY_LABELS[plan.family], sublabel: null };
}

/**
 * Resolve the plan an account BEHAVES as, plus its effective entitlements,
 * from one row.
 *
 * Plan precedence:
 *   1. no row                 → `none`     (fail-closed)
 *   2. active trial that outranks the stored tier → its features; its plan too,
 *      unless it is an Enterprise trial (never a tier write)
 *   3. stored tier (legacy keys resolve to `credits`)
 *
 * Entitlement layering:
 *   plan entitlements → SSO/SCIM grace after an Enterprise trial →
 *   per-feature overrides (each unexpired `entitlement_overrides` key wins).
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
      source: 'no_account',
      entitlements: { ...plan.entitlements },
      grace: null,
      display: displayFor(plan),
    };
  }

  const onTrial = trialIsActive(row, nowMs);
  // A row with no tier reads as 'none', not 'free'.
  const stored = resolvePlanRecord(row.tier ?? 'none');
  // A trial never lowers what the stored plan grants.
  const lent = onTrial ? resolvePlanRecord(row.trialTier as string) : null;
  const trialWins = lent !== null && lent.rank > stored.rank;
  const features = trialWins ? lent : stored;
  // An Enterprise trial lends the features only; a Credits trial lends the plan.
  const plan = trialWins && lent.family !== 'enterprise' ? lent : stored;
  const source: BillingPlanSource = trialWins ? 'trial' : 'stored';

  const entitlements: PlanRecord['entitlements'] = { ...features.entitlements };
  const grace = onTrial ? null : trialGrace(row, nowMs);
  if (grace) {
    entitlements.sso = true;
    entitlements.scim = true;
  }

  for (const key of ENTITLEMENT_OVERRIDE_KEYS) {
    const value = readOverride(row.entitlementOverrides, key, nowMs);
    if (value !== undefined) entitlements[key] = value;
  }

  return { plan, features, source, entitlements, grace, display: displayFor(plan) };
}
