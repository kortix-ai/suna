// Account-level enterprise entitlement resolution.
//
// Maps an account → its billing tier → the tier's enterprise feature gates
// (SSO, SCIM, …). This is the DB-backed bridge between the pure tier config
// (tiers.ts) and the request-time guards in the IAM routes / SCIM data plane.
//
// An account with no credit row resolves to tier 'none' (all entitlements
// false) — fail-closed, so an unprovisioned account can never reach an
// enterprise surface.

import { config } from '../../config';
import type { TierEntitlements } from '../../types';
import { getCreditAccount } from '../repositories/credit-accounts';
import { resolveEffectiveTier } from './effective-tier';
import { getTierEntitlements, tierGrantsAllModels, tierHasEntitlement } from './tiers';

/**
 * Resolve the tier name backing an account ('none' if no billing row).
 * This is the EFFECTIVE tier: an active admin-issued trial and the per-seat
 * self-heal overlay the stored `credit_accounts.tier` (see effective-tier.ts).
 */
export async function getAccountTier(accountId: string): Promise<string> {
  const acct = await getCreditAccount(accountId);
  return resolveEffectiveTier(acct);
}

const TIER_CACHE_TTL_MS = 30_000;
type TierSnapshot = { tier: string; managedModels: boolean };
const accountTierCache = new Map<string, TierSnapshot & { expiresAt: number }>();

async function loadTierSnapshot(accountId: string, now: number): Promise<TierSnapshot> {
  const acct = await getCreditAccount(accountId);
  const tier = resolveEffectiveTier(acct, now);
  // Managed-models entitlement: the operator override wins in both directions
  // (grant managed models to a BYOK/credit tier, or force an account BYOK-only
  // regardless of tier); NULL means the effective tier decides.
  const managedModels =
    typeof acct?.managedModelsOverride === 'boolean'
      ? acct.managedModelsOverride
      : tierGrantsAllModels(tier);
  return { tier, managedModels };
}

async function getCachedTierSnapshot(accountId: string, now: number): Promise<TierSnapshot> {
  const cached = accountTierCache.get(accountId);
  if (cached && cached.expiresAt > now) return cached;
  const snapshot = await loadTierSnapshot(accountId, now);
  accountTierCache.set(accountId, { ...snapshot, expiresAt: now + TIER_CACHE_TTL_MS });
  return snapshot;
}

/**
 * getAccountTier with a short per-process TTL cache — the SINGLE tier cache for
 * the whole gateway control plane. Used on the gateway auth hot path (every
 * chat-completions request authenticates, withResolvedTier in llm-gateway/
 * hooks.ts) AND by resolveCandidates (llm-gateway/resolution/resolve-
 * candidates.ts) for the BYOK platform-fee/waiver decision and the managed-
 * model free-tier gate. Previously each of those had its OWN independent 30s-
 * TTL cache/Map, so the BYOK fee decision and the managed-model gate could see
 * different tiers (stale vs fresh) for up to 30s after an upgrade/downgrade,
 * independently of each other — unifying to one cache with one invalidation
 * point removes that skew (both call sites now share the same cached value and
 * expire at the same wall-clock instant for a given account). Tiers change
 * rarely; 30s is fine.
 */
// `now` is injectable (defaults to Date.now()) purely so the 30s TTL boundary
// is unit-testable without a real wall-clock sleep — every production call
// site leaves it unset and gets the real clock.
export async function getCachedAccountTier(
  accountId: string,
  now: number = Date.now(),
): Promise<string> {
  return (await getCachedTierSnapshot(accountId, now)).tier;
}

/**
 * Whether the account may use Kortix-managed model credentials (vs BYOK only).
 * THE single request-time answer for the whole control plane — the gateway auth
 * hot path, resolveCandidates' managed gate, the sandbox-provision gateway
 * mount, and every model-picker/catalog narrowing consult this instead of
 * deriving it from a tier string themselves, so the operator override and the
 * trial overlay cannot skew between surfaces. Shares the tier snapshot cache
 * (same TTL, same invalidation point).
 */
export async function accountMayUseManagedModels(
  accountId: string,
  now: number = Date.now(),
): Promise<boolean> {
  // Billing off (local / self-hosted): the tier system is a no-op and every
  // account sees the full lineup — same convention as the limit resolvers.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return true;
  return (await getCachedTierSnapshot(accountId, now)).managedModels;
}

/**
 * Invalidate the cached tier for one account (or the whole cache when no id is
 * given). Exposed so a tier-change webhook/admin action can force an immediate
 * re-read instead of waiting out the TTL, and so tests can deterministically
 * exercise "tier changed mid-window" without faking timers.
 */
export function invalidateCachedAccountTier(accountId?: string): void {
  if (accountId) accountTierCache.delete(accountId);
  else accountTierCache.clear();
}

/** The full enterprise entitlement set for an account. */
export async function getAccountEntitlements(
  accountId: string,
  prefetchedAccount?: Awaited<ReturnType<typeof getCreditAccount>>,
): Promise<TierEntitlements> {
  // Self-host enterprise license: an operator holding a Kortix Enterprise
  // license unlocks every enterprise entitlement platform-wide, regardless of
  // billing tier — self-host has no Stripe-backed tier to assign 'enterprise'
  // to. Checked before the per-account overrides so a licensed operator never
  // needs to also flip a per-account flag.
  if (config.ENTERPRISE_LICENSE_AVAILABLE) return getTierEntitlements('enterprise');
  const acct = prefetchedAccount !== undefined ? prefetchedAccount : await getCreditAccount(accountId);
  // Contracted cloud Enterprise: an operator sets `enterprise_entitled` when
  // an account signs an Enterprise agreement. This grants the full enterprise
  // entitlement set (SSO/SCIM/RBAC/audit) regardless of `tier`, so a deal that
  // is BOTH Enterprise (entitlements) AND per-seat (billing) can hold both at
  // once — `tier`/`billing_model` may be `per_seat` for Stripe seat
  // reconciliation while enterprise identity surfaces stay on. Without this,
  // the per-seat webhook reconciliation clobbers `tier` to `per_seat` and
  // strips entitlements on every ordinary subscription update. Distinct from
  // the demo flag below: this is the real-contract flag, set out-of-band by an
  // operator at sign-up time.
  if (acct?.enterpriseEntitled) return getTierEntitlements('enterprise');
  // Demo/dogfood override: an account can self-enable an interactive demo of the
  // enterprise surface from account settings. When on, it unlocks EVERY
  // enterprise entitlement — whatever the `enterprise` tier grants — regardless
  // of billing tier, so gates added later are covered automatically. This is a
  // preview, NOT a real Enterprise plan (which is sales-assigned or set via
  // `enterprise_entitled`).
  if (acct?.demoEnterprise) return getTierEntitlements('enterprise');
  // Effective tier: an active admin-issued trial overlays the stored tier, so
  // a trial of an entitled tier (e.g. 'enterprise') grants its feature set for
  // exactly the trial window and lapses back on expiry with no cron involved.
  return getTierEntitlements(resolveEffectiveTier(acct));
}

/** Whether an account's plan unlocks a specific enterprise feature. */
export async function accountHasEntitlement(
  accountId: string,
  key: keyof TierEntitlements,
): Promise<boolean> {
  if (config.ENTERPRISE_LICENSE_AVAILABLE) return true;
  const acct = await getCreditAccount(accountId);
  if (acct?.enterpriseEntitled) return true;
  if (acct?.demoEnterprise) return true;
  return tierHasEntitlement(resolveEffectiveTier(acct), key);
}
