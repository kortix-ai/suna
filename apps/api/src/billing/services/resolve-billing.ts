/**
 * One pure function that answers "what is this account's billing situation?"
 * from a single credit_accounts row.
 *
 * Today that answer is assembled by three separate layers that each re-derive
 * part of it: `resolveEffectiveTier` (trial overlay + per-seat self-heal),
 * `getAccountEntitlements` (enterprise_entitled / demo_enterprise /
 * managed_models_override), and `resolveAccountSessionLimit`
 * (max_concurrent_sessions override). Every surface picks a different subset,
 * which is how they skew. This module states the whole thing once.
 *
 * PURE, and deliberately so — it takes the row, not an accountId, and returns a
 * value with no I/O, no clock of its own, and no cache. NOTHING CONSUMES IT
 * YET: it lands with the parity tests first so the equivalence is proven before
 * any caller is switched. The cache wrapper lands with that flip.
 *
 * ZERO BEHAVIOR CHANGE is the whole contract. Every branch below reproduces a
 * cited branch of today's code.
 */

import {
  PLAN_FAMILY_LABELS,
  type PlanRecord,
  getPlanRecord,
  resolvePlanRecord,
} from './plan-catalog';
import { isPaidTier, isPerSeatAccount } from './tier-facts';

/**
 * Trial/subscription/override columns this resolver reads. A structural subset
 * of `getSubscriptionInfo`'s row plus the two enterprise flags from
 * `getCreditAccount`, so either row shape can be passed directly.
 */
export interface BillingRow {
  tier?: string | null;
  trialStatus?: string | null;
  trialTier?: string | null;
  trialEndsAt?: string | null;
  billingModel?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  enterpriseEntitled?: boolean | null;
  demoEnterprise?: boolean | null;
  managedModelsOverride?: boolean | null;
  maxConcurrentSessions?: number | null;
}

/** Where the resolved plan came from. */
export type BillingPlanSource = 'no_account' | 'trial' | 'per_seat_selfheal' | 'stored';

/** Where a resolved limit came from. */
export type BillingLimitSource = 'plan' | 'account_override';

export interface ResolvedBilling {
  plan: PlanRecord;
  source: BillingPlanSource;
  /** Plan entitlements with the account-level overrides applied. */
  entitlements: PlanRecord['entitlements'];
  limits: { concurrentSessions: { value: number; source: BillingLimitSource } };
  /** Customer-facing naming. Not wired to any surface yet. */
  display: { label: string; sublabel: string | null };
}

const TRIAL_STATUS_ACTIVE = 'active';

/**
 * `trialIsActive` from `effective-tier.ts`, replicated rather than imported:
 * that module imports `isValidTier` from `tiers.ts`, which boots env validation
 * at module scope, and this module must stay pure. Membership in the catalog is
 * the same predicate as `isValidTier` — both cover exactly the same 16 tier
 * keys, which the parity test asserts.
 */
function trialIsActive(row: BillingRow, nowMs: number): boolean {
  if (row.trialStatus !== TRIAL_STATUS_ACTIVE) return false;
  if (!row.trialTier || !getPlanRecord(row.trialTier)) return false;
  if (!row.trialEndsAt) return false;
  const endsAt = new Date(row.trialEndsAt).getTime();
  return Number.isFinite(endsAt) && endsAt > nowMs;
}

/**
 * `coercePerSeatTier` from `effective-tier.ts`, replicated for the same reason.
 * A paying seat subscription overrides a stored non-paid tier so stale rows
 * cannot gate a paying team as free.
 */
function coercePerSeatTier(rawTier: string, row: BillingRow): string {
  if (
    !isPaidTier(rawTier) &&
    isPerSeatAccount(row.billingModel) &&
    !!row.stripeSubscriptionId &&
    row.stripeSubscriptionStatus !== 'canceled' &&
    row.stripeSubscriptionStatus !== 'unpaid'
  ) {
    return 'per_seat';
  }
  return rawTier;
}

/** Positive-integer override, or null. Mirrors `resolveAccountLimitInfo`. */
function positiveOverride(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function displayFor(plan: PlanRecord): { label: string; sublabel: string | null } {
  const label = PLAN_FAMILY_LABELS[plan.family];
  if (plan.status !== 'grandfathered') return { label, sublabel: null };
  const per = plan.price.unit === 'seat_month' ? '/seat/mo' : '/mo';
  return { label, sublabel: `$${plan.price.amountUsd}${per} · grandfathered` };
}

/**
 * Resolve the plan an account BEHAVES as, plus its effective entitlements and
 * limits, from one row.
 *
 * Plan precedence (`resolveEffectiveTier`, effective-tier.ts:93-100):
 *   1. no row                 → `none`     (fail-closed)
 *   2. active admin trial     → trial tier (overlay, never a tier write)
 *   3. per-seat self-heal     → `per_seat`
 *   4. stored tier
 *
 * Override precedence (`getAccountEntitlements`, entitlements.ts:107-140):
 *   enterprise_entitled → demo_enterprise → plan. `ENTERPRISE_LICENSE_AVAILABLE`
 *   sits above both in that function but is an ENV fact, not a row fact, so it
 *   stays with the (impure) caller.
 *
 * `managed_models_override` is tri-state (`loadTierSnapshot`,
 * entitlements.ts:31-42): a boolean wins in both directions, NULL defers to the
 * plan. `max_concurrent_sessions` overrides the plan cap in both directions
 * (`resolveAccountSessionLimit`, shared/account-limits.ts:151-160).
 */
export function resolveBillingFromRow(
  row: BillingRow | null | undefined,
  nowMs: number = Date.now(),
): ResolvedBilling {
  if (!row) {
    const plan = resolvePlanRecord('none');
    return {
      plan,
      source: 'no_account',
      entitlements: { ...plan.entitlements },
      limits: {
        concurrentSessions: { value: plan.limits.concurrentSessions, source: 'plan' },
      },
      display: displayFor(plan),
    };
  }

  let source: BillingPlanSource;
  let key: string;
  if (trialIsActive(row, nowMs)) {
    source = 'trial';
    key = row.trialTier as string;
  } else {
    // resolveEffectiveTier passes `acct.tier ?? 'none'` — a row with no tier
    // reads as 'none', not 'free'.
    const stored = row.tier ?? 'none';
    key = coercePerSeatTier(stored, row);
    source = key === stored ? 'stored' : 'per_seat_selfheal';
  }

  const plan = resolvePlanRecord(key);

  const enterpriseOverlay = row.enterpriseEntitled === true || row.demoEnterprise === true;
  const enterprisePlan = resolvePlanRecord('enterprise');
  const entitlements: PlanRecord['entitlements'] = {
    ...plan.entitlements,
    ...(enterpriseOverlay
      ? {
          sso: enterprisePlan.entitlements.sso,
          scim: enterprisePlan.entitlements.scim,
          rbac: enterprisePlan.entitlements.rbac,
          auditAccess: enterprisePlan.entitlements.auditAccess,
        }
      : {}),
    managedModels:
      typeof row.managedModelsOverride === 'boolean'
        ? row.managedModelsOverride
        : plan.entitlements.managedModels,
  };

  const sessionOverride = positiveOverride(row.maxConcurrentSessions);

  return {
    plan,
    source,
    entitlements,
    limits: {
      concurrentSessions:
        sessionOverride !== null
          ? { value: sessionOverride, source: 'account_override' }
          : { value: plan.limits.concurrentSessions, source: 'plan' },
    },
    display: displayFor(plan),
  };
}
