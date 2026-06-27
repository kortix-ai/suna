// Account-level enterprise entitlement resolution.
//
// Maps an account → its billing tier → the tier's enterprise feature gates
// (SSO, SCIM, …). This is the DB-backed bridge between the pure tier config
// (tiers.ts) and the request-time guards in the IAM routes / SCIM data plane.
//
// An account with no credit row resolves to tier 'none' (all entitlements
// false) — fail-closed, so an unprovisioned account can never reach an
// enterprise surface.

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
 * getAccountTier with a short per-process TTL cache. Used on the gateway auth
 * hot path (every chat-completions request authenticates), where the tier is
 * needed to decide a free account's model visibility + `auto` routing and a
 * fresh DB read per request would be wasteful. Tiers change rarely; 30s is fine.
 */
export async function getCachedAccountTier(accountId: string): Promise<string> {
  const cached = accountTierCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;
  const tier = await getAccountTier(accountId);
  accountTierCache.set(accountId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
  return tier;
}

/** The full enterprise entitlement set for an account. */
export async function getAccountEntitlements(accountId: string): Promise<TierEntitlements> {
  return getTierEntitlements(await getAccountTier(accountId));
}

/** Whether an account's plan unlocks a specific enterprise feature. */
export async function accountHasEntitlement(
  accountId: string,
  key: keyof TierEntitlements,
): Promise<boolean> {
  return tierHasEntitlement(await getAccountTier(accountId), key);
}
