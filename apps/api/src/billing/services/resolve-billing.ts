/**
 * One pure function that answers "what is this account's billing situation?"
 * from a single credit_accounts row: the plan it behaves as (trial overlay),
 * its entitlements after the account-level overrides, and
 * its compute price. Entitlements, limits, and account state
 * all read it through the cache in `billing-cache.ts`, so no surface
 * re-derives part of the answer and skews from the others.
 *
 * PURE, and deliberately so — it takes the row, not an accountId, and returns a
 * value with no I/O, no clock of its own, and no cache.
 */

import {
  ENTITLEMENT_OVERRIDE_KEYS,
  clampComputeRateMultiplier,
  readOverride,
} from './entitlement-overrides';
import {
  PLAN_FAMILY_LABELS,
  type PlanRecord,
  getPlanRecord,
  resolvePlanRecord,
} from './plan-catalog';

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
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  enterpriseEntitled?: boolean | null;
  demoEnterprise?: boolean | null;
  managedModelsOverride?: boolean | null;
  /**
   * `credit_accounts.entitlement_overrides` — the JSONB override map, each
   * entry optionally expiring. `unknown` because it is operator-written data
   * the parser must not trust; see `entitlement-overrides.ts`.
   */
  entitlementOverrides?: unknown;
}

/** Where the resolved plan came from. */
export type BillingPlanSource = 'no_account' | 'trial' | 'stored';

/** Where a resolved limit came from. */
export type BillingLimitSource = 'plan' | 'account_override';

export interface ResolvedBilling {
  plan: PlanRecord;
  source: BillingPlanSource;
  /** Plan entitlements with the account-level overrides applied. */
  entitlements: PlanRecord['entitlements'];
  /**
   * Compute pricing for this account. `rateMultiplier` scales the provider
   * rate card in `compute-metering.ts`: 1.0 is list price (every account
   * today), 0 is free compute, and the ceiling is
   * `MAX_COMPUTE_RATE_MULTIPLIER`.
   */
  compute: { rateMultiplier: number; source: BillingLimitSource };
  /** Customer-facing naming. Not wired to any surface yet. */
  display: { label: string; sublabel: string | null };
}

const TRIAL_STATUS_ACTIVE = 'active';

/**
 * Whether the row carries a currently-granting admin-issued trial. Expiry is
 * LAZY: an expired trial stops granting the instant `trial_ends_at` passes,
 * whether or not the cron has flipped `trial_status` yet. Membership in the
 * catalog is the same predicate as `isValidTier` (which this pure module cannot
 * import: `tiers.ts` boots env validation) — both cover the same 16 tier keys,
 * which the parity test asserts.
 */
function trialIsActive(row: BillingRow, nowMs: number): boolean {
  if (row.trialStatus !== TRIAL_STATUS_ACTIVE) return false;
  if (!row.trialTier || !getPlanRecord(row.trialTier)) return false;
  if (!row.trialEndsAt) return false;
  const endsAt = new Date(row.trialEndsAt).getTime();
  return Number.isFinite(endsAt) && endsAt > nowMs;
}

function displayFor(plan: PlanRecord): { label: string; sublabel: string | null } {
  return { label: PLAN_FAMILY_LABELS[plan.family], sublabel: null };
}

/**
 * Resolve the plan an account BEHAVES as, plus its effective entitlements and
 * limits, from one row.
 *
 * Plan precedence:
 *   1. no row                 → `none`     (fail-closed)
 *   2. active admin trial     → trial tier (overlay, never a tier write)
 *   3. stored tier (legacy keys resolve to `credits`)
 *
 * Override precedence (`getAccountEntitlements`, entitlements.ts:107-140):
 *   enterprise_entitled → demo_enterprise → plan. `ENTERPRISE_LICENSE_AVAILABLE`
 *   sits above both in that function but is an ENV fact, not a row fact, so it
 *   stays with the (impure) caller.
 *
 * `managed_models_override` is tri-state (`loadTierSnapshot`,
 * entitlements.ts:31-42): a boolean wins in both directions, NULL defers to the
 * plan.
 *
 * Source precedence for every override (see `entitlement-overrides.ts`):
 *   1. `entitlement_overrides.<key>` — if present AND unexpired at `nowMs`
 *   2. the legacy column of the same name — if the key is absent
 *   3. the plan record
 * and the layering within one resolve is:
 *   plan entitlements → enterprise expansion (enterprise_entitled /
 *   demo_enterprise) → managed-models override → PER-ENTITLEMENT overrides.
 * The last step is what lets one capability be switched off independently of
 * the all-or-nothing enterprise flag.
 */
/**
 * Whether the row carries a contracted Enterprise entitlement: the JSONB
 * override when present and unexpired, else the legacy column. Every check of
 * "is this an Enterprise contract" goes through here, so the two stores cannot
 * disagree.
 */
export function enterpriseEntitledFromRow(
  row: { enterpriseEntitled?: boolean | null; entitlementOverrides?: unknown } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!row) return false;
  return readOverride(row.entitlementOverrides, 'enterpriseEntitled', nowMs) ?? row.enterpriseEntitled === true;
}

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
      compute: { rateMultiplier: plan.compute.rateMultiplier, source: 'plan' },
      display: displayFor(plan),
    };
  }

  let source: BillingPlanSource;
  let key: string;
  if (trialIsActive(row, nowMs)) {
    source = 'trial';
    key = row.trialTier as string;
  } else {
    // A row with no tier reads as 'none', not 'free'.
    key = row.tier ?? 'none';
    source = 'stored';
  }

  const plan = resolvePlanRecord(key);
  const ov = row.entitlementOverrides;

  // OVERRIDE PRECEDENCE, per key: the JSONB entry (when present and unexpired)
  // wins over the legacy column of the same name; an absent key falls back to
  // the column. Per KEY, not per row — an account can carry an expiring
  // `managedModelsOverride` in the JSONB and a permanent `enterprise_entitled`
  // in its column at the same time, and each resolves from its own source.
  const enterpriseEntitled = enterpriseEntitledFromRow(row, nowMs);
  const demoEnterprise = readOverride(ov, 'demoEnterprise', nowMs) ?? row.demoEnterprise === true;
  const managedModelsOverride =
    readOverride(ov, 'managedModelsOverride', nowMs) ??
    (typeof row.managedModelsOverride === 'boolean' ? row.managedModelsOverride : undefined);

  const enterpriseOverlay = enterpriseEntitled || demoEnterprise;
  const enterprisePlan = resolvePlanRecord('enterprise');
  const entitlements: PlanRecord['entitlements'] = {
    ...plan.entitlements,
    ...(enterpriseOverlay
      ? {
          sso: enterprisePlan.entitlements.sso,
          scim: enterprisePlan.entitlements.scim,
          rbac: enterprisePlan.entitlements.rbac,
          auditAccess: enterprisePlan.entitlements.auditAccess,
          branding: enterprisePlan.entitlements.branding,
        }
      : {}),
    managedModels: managedModelsOverride ?? plan.entitlements.managedModels,
  };

  // Per-entitlement overrides land LAST, so they beat the enterprise expansion
  // above: `sso: {value:false}` switches SSO off for an enterprise-entitled
  // account (a contract that excludes it, an abuse containment) without
  // touching the other three. There is no other way to express that — the
  // enterprise flag is all-or-nothing by construction.
  for (const entKey of ENTITLEMENT_OVERRIDE_KEYS) {
    const value = readOverride(ov, entKey, nowMs);
    if (value !== undefined) entitlements[entKey] = value;
  }

  // Custom compute pricing. No legacy column to fall back to — this override
  // has only ever existed in the JSONB — so the plan record's own multiplier
  // (1.0 everywhere today) is the floor.
  const rateOverride = readOverride(ov, 'computeRateMultiplier', nowMs);

  return {
    plan,
    source,
    entitlements,
    compute:
      rateOverride !== undefined
        ? { rateMultiplier: clampComputeRateMultiplier(rateOverride), source: 'account_override' }
        : { rateMultiplier: plan.compute.rateMultiplier, source: 'plan' },
    display: displayFor(plan),
  };
}
