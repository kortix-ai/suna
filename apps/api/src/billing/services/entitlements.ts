// Account-level tier + entitlement resolution.
//
// Maps an account → the plan it BEHAVES as → that plan's entitlements (managed
// models, SSO, SCIM, …). This is the DB-backed bridge between the plan catalog
// (plan-catalog.ts) and the request-time guards in the gateway and the IAM
// routes / SCIM data plane.
//
// Every function here is now a thin projection of ONE answer:
// `resolveAccountBilling` (billing-cache.ts) → `resolveBillingFromRow`
// (resolve-billing.ts). The trial overlay, the per-seat self-heal, the
// `enterprise_entitled` / `demo_enterprise` overlays, and the tri-state
// `managed_models_override` are all applied there, once, so no two surfaces can
// derive a different answer from the same row.
//
// An account with no credit row resolves to plan 'none' (all entitlements
// false) — fail-closed, so an unprovisioned account can never reach an
// enterprise surface.

import { config } from '../../config';
import type { TierEntitlements } from '../../types';
import type { getCreditAccount } from '../repositories/credit-accounts';
import { invalidateAccountBilling, resolveAccountBilling } from './billing-cache';
import { resolvePlanRecord } from './plan-catalog';
import type { ResolvedBilling } from './resolve-billing';

/** The four enterprise feature gates, projected out of a resolved plan. */
function enterpriseGates(resolved: ResolvedBilling): TierEntitlements {
  const { sso, scim, rbac, auditAccess } = resolved.entitlements;
  return { sso, scim, rbac, auditAccess };
}

/**
 * The entitlement set a self-host Kortix Enterprise license grants. Read from
 * the plan catalog rather than `getTierEntitlements('enterprise')` so this
 * module never imports `tiers.ts` (which boots env validation at module scope).
 * The parity test pins the two to the same values.
 */
function enterpriseLicenseGates(): TierEntitlements {
  const { sso, scim, rbac, auditAccess } = resolvePlanRecord('enterprise').entitlements;
  return { sso, scim, rbac, auditAccess };
}

/**
 * Resolve the plan key backing an account ('none' if no billing row).
 * This is the EFFECTIVE plan: an active admin-issued trial and the per-seat
 * self-heal overlay the stored `credit_accounts.tier`. Uncached — callers that
 * want the hot-path cache use `getCachedAccountTier`.
 *
 * A stored tier that is not in the catalog normalizes to 'none' (fail-closed),
 * which is what `getTier()` already did to it at every downstream use.
 */
export async function getAccountTier(accountId: string): Promise<string> {
  return (await resolveAccountBilling(accountId, { fresh: true })).plan.key;
}

/**
 * getAccountTier with the shared 30s billing cache — the SINGLE cache for the
 * whole control plane (billing-cache.ts). Used on the gateway auth hot path
 * (every chat-completions request authenticates, withResolvedTier in
 * llm-gateway/hooks.ts) AND by resolveCandidates (llm-gateway/resolution/
 * resolve-candidates.ts) for the BYOK platform-fee/waiver decision and the
 * managed-model gate. Every one of those reads the same cached value and
 * expires at the same wall-clock instant for a given account, so an upgrade or
 * downgrade can never be visible to one decision and invisible to another.
 * Plans change rarely; 30s is fine.
 */
// `now` is injectable (defaults to Date.now()) purely so the 30s TTL boundary
// is unit-testable without a real wall-clock sleep — every production call
// site leaves it unset and gets the real clock.
export async function getCachedAccountTier(
  accountId: string,
  now: number = Date.now(),
): Promise<string> {
  return (await resolveAccountBilling(accountId, { now })).plan.key;
}

/**
 * Whether the account may use Kortix-managed model credentials (vs BYOK only).
 * THE single request-time answer for the whole control plane — the gateway auth
 * hot path, resolveCandidates' managed gate, the Slack/Teams channel model
 * gate, the sandbox-provision gateway mount, and every model-picker/catalog
 * narrowing consult this instead of deriving it from a tier string themselves,
 * so the operator `managed_models_override` and the trial overlay cannot skew
 * between surfaces. Shares the billing cache (same TTL, same invalidation).
 */
export async function accountMayUseManagedModels(
  accountId: string,
  now: number = Date.now(),
): Promise<boolean> {
  // Billing off (local / self-hosted): the tier system is a no-op and every
  // account sees the full lineup — same convention as the limit resolvers.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return true;
  return (await resolveAccountBilling(accountId, { now })).entitlements.managedModels;
}

/**
 * Invalidate the cached billing view for one account (or the whole cache when
 * no id is given). Kept under its historical name because many call sites
 * import it; it is a thin alias of `invalidateAccountBilling`, which now also
 * covers what `clearAccountLimitCache` used to clear separately.
 */
export function invalidateCachedAccountTier(accountId?: string): void {
  invalidateAccountBilling(accountId);
}

/**
 * The full enterprise entitlement set for an account.
 *
 * Resolution order (all but the first live inside `resolveBillingFromRow`):
 *   1. `ENTERPRISE_LICENSE_AVAILABLE` — a self-host operator holding a Kortix
 *      Enterprise license unlocks every enterprise entitlement platform-wide,
 *      regardless of billing tier (self-host has no Stripe-backed tier to
 *      assign 'enterprise' to). An ENV fact, not a row fact, so it stays here.
 *   2. `enterprise_entitled` — the real-contract flag an operator sets when an
 *      account signs an Enterprise agreement. Grants the full set regardless of
 *      `tier`, so a deal that is BOTH Enterprise (entitlements) AND per-seat
 *      (billing) holds both at once; without it the per-seat webhook
 *      reconciliation clobbers `tier` and strips entitlements on every ordinary
 *      subscription update.
 *   3. `demo_enterprise` — the self-serve demo of the enterprise surface. A
 *      preview, NOT a real Enterprise plan.
 *   4. the effective plan — so a trial of an entitled tier grants its feature
 *      set for exactly the trial window and lapses on expiry with no cron.
 *
 * Reads fresh, not cached: an admin flipping one of these flags must be visible
 * on the next request, and these gates are not on a hot path.
 */
export async function getAccountEntitlements(
  accountId: string,
  prefetchedAccount?: Awaited<ReturnType<typeof getCreditAccount>>,
): Promise<TierEntitlements> {
  if (config.ENTERPRISE_LICENSE_AVAILABLE) return enterpriseLicenseGates();
  const resolved = await resolveAccountBilling(
    accountId,
    // `undefined` means "fetch the row"; `null` means "this account has none".
    prefetchedAccount !== undefined ? { row: prefetchedAccount } : { fresh: true },
  );
  return enterpriseGates(resolved);
}

/** Whether an account's plan unlocks a specific enterprise feature. */
export async function accountHasEntitlement(
  accountId: string,
  key: keyof TierEntitlements,
): Promise<boolean> {
  if (config.ENTERPRISE_LICENSE_AVAILABLE) return true;
  return (await getAccountEntitlements(accountId))[key] === true;
}
