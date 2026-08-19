/**
 * The ONE account-billing cache for the API process.
 *
 * `resolve-billing.ts` answers "what is this account's billing situation?" from
 * a row. This module is the only thing that turns an `accountId` into that
 * answer: it loads the `credit_accounts` row, calls the pure resolver, and keeps
 * the result in a single Map with a 30s TTL.
 *
 * It REPLACES two caches that used to hold overlapping views of the same row:
 *   - `accountTierCache` in `billing/services/entitlements.ts` (30s) — effective
 *     tier + managed-models entitlement, read on the gateway auth hot path.
 *   - `accountLimitCache` in `shared/account-limits.ts` (60s) — effective tier +
 *     the max_concurrent_sessions override, read by the project/session limits.
 * Two caches over one row means two expiry clocks: for up to 60s after an
 * upgrade, downgrade, trial grant, or trial revoke the limit layer and the
 * entitlement layer could disagree about the same account. One cache with one
 * invalidation point removes that skew. The unified TTL is 30s (the shorter of
 * the two), so nothing gets staler than it was.
 *
 * `now` is injectable on every entry point (defaults to `Date.now()`) so the TTL
 * boundary stays unit-testable without a wall-clock sleep. Production callers
 * leave it unset.
 */

import { getCreditAccount } from '../repositories/credit-accounts';
import { type BillingRow, type ResolvedBilling, resolveBillingFromRow } from './resolve-billing';

/**
 * Unified TTL. Shorter of the two caches this replaces (30s tier / 60s limits),
 * so no consumer sees a value staler than it did before.
 */
export const BILLING_CACHE_TTL_MS = 30_000;

const cache = new Map<string, { resolved: ResolvedBilling; expiresAt: number }>();

export interface ResolveAccountBillingOptions {
  /**
   * Bypass the cached value and re-read the row. The fresh result still
   * populates the cache. Use where a stale answer is not acceptable — e.g.
   * `resolveAccountSessionLimit`, which must observe an operator-set override
   * immediately, and every entitlement gate that an admin action can flip.
   */
  fresh?: boolean;
  /**
   * A `credit_accounts` row the caller already has. Skips the read entirely
   * (and the cache lookup — a row in hand is by definition fresher than the
   * cache). `null` means "this account has no row", not "go fetch it";
   * `undefined` means "fetch it".
   */
  row?: BillingRow | null;
  /** Injectable clock for TTL tests. */
  now?: number;
}

/**
 * The account's resolved billing situation: plan, source, entitlements, limits,
 * display. Cached for 30s per account unless `fresh` or `row` is given.
 */
export async function resolveAccountBilling(
  accountId: string,
  options: ResolveAccountBillingOptions = {},
): Promise<ResolvedBilling> {
  const now = options.now ?? Date.now();
  const rowGiven = options.row !== undefined;

  if (!options.fresh && !rowGiven) {
    const cached = cache.get(accountId);
    if (cached && cached.expiresAt > now) return cached.resolved;
  }

  const row = rowGiven ? (options.row as BillingRow | null) : await getCreditAccount(accountId);
  const resolved = resolveBillingFromRow(row, now);
  cache.set(accountId, { resolved, expiresAt: now + BILLING_CACHE_TTL_MS });
  return resolved;
}

/**
 * Drop the cached billing view for one account, or (with no id) for every
 * account. The single invalidation point for the whole control plane — a
 * tier-change webhook, a trial grant/revoke, or an admin override flip calls
 * this and the next read is live, instead of waiting out the TTL.
 */
export function invalidateAccountBilling(accountId?: string): void {
  if (accountId) cache.delete(accountId);
  else cache.clear();
}
