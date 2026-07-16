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
import { getTierEntitlements, tierHasEntitlement } from './tiers';

/** Resolve the tier name backing an account ('none' if no billing row). */
export async function getAccountTier(accountId: string): Promise<string> {
  const acct = await getCreditAccount(accountId);
  return acct?.tier ?? 'none';
}

const TIER_CACHE_TTL_MS = 30_000;
const accountTierCache = new Map<string, { tier: string; expiresAt: number }>();

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
export async function getCachedAccountTier(accountId: string): Promise<string> {
  const cached = accountTierCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;
  const tier = await getAccountTier(accountId);
  accountTierCache.set(accountId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
  return tier;
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
export async function getAccountEntitlements(accountId: string): Promise<TierEntitlements> {
  // Self-host enterprise license: an operator holding a Kortix Enterprise
  // license unlocks every enterprise entitlement platform-wide, regardless of
  // billing tier — self-host has no Stripe-backed tier to assign 'enterprise'
  // to. Checked before the per-account demo override so a licensed operator
  // never needs to also flip the per-account demo toggle.
  if (config.ENTERPRISE_LICENSE_AVAILABLE) return getTierEntitlements('enterprise');
  const acct = await getCreditAccount(accountId);
  // Demo/dogfood override: an account can self-enable an interactive demo of the
  // enterprise surface from account settings. When on, it unlocks EVERY
  // enterprise entitlement — whatever the `enterprise` tier grants — regardless
  // of billing tier, so gates added later are covered automatically. This is a
  // preview, NOT a real Enterprise plan (which is sales-assigned).
  if (acct?.demoEnterprise) return getTierEntitlements('enterprise');
  return getTierEntitlements(acct?.tier ?? 'none');
}

/** Whether an account's plan unlocks a specific enterprise feature. */
export async function accountHasEntitlement(
  accountId: string,
  key: keyof TierEntitlements,
): Promise<boolean> {
  if (config.ENTERPRISE_LICENSE_AVAILABLE) return true;
  const acct = await getCreditAccount(accountId);
  if (acct?.demoEnterprise) return true;
  return tierHasEntitlement(acct?.tier ?? 'none', key);
}
