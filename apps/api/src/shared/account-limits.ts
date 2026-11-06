import { config } from '../config';
import { invalidateAccountBilling, resolveAccountBilling } from '../billing/services/billing-cache';
import { getPlanRecord } from '../billing/services/plan-catalog';
import type { RateLimitPolicy } from './rate-limit';

type AccountLimitInfo = {
  tier: string | null;
};

function positiveInt(value: unknown, fallback: number) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The limit layer's view of an account, projected out of the ONE resolved
 * billing answer (billing/services/billing-cache.ts → resolve-billing.ts).
 *
 * This used to be a second 60s cache over the same `credit_accounts` row that
 * `entitlements.ts` was already caching for 30s — two expiry clocks over one
 * row, so the limit layer and the entitlement layer could disagree about an
 * account for up to 60s after an upgrade, downgrade, or trial change. There is
 * now one cache and one invalidation point.
 *
 * The effective plan = active trial overlay > stored tier. The trial overlay
 * lets an admin-issued trial lift rate limits for exactly the trial window.
 * A workspace holds one project on every plan (`workspaces/one-project.ts`),
 * so no plan sets a project count.
 */
async function resolveAccountLimitInfo(accountId: string): Promise<AccountLimitInfo> {
  try {
    const resolved = await resolveAccountBilling(accountId);
    return {
      // No credit row at all reads as 'free' HERE (not 'none'): the limit layer
      // has always treated an unprovisioned account as free rather than
      // failing it closed. Entitlement gates fail closed to 'none' instead —
      // a different question, deliberately.
      tier: resolved.source === 'no_account' ? 'free' : resolved.features.key,
    };
  } catch {
    return { tier: 'free' };
  }
}

export async function resolveAccountTier(accountId: string): Promise<string | null> {
  return (await resolveAccountLimitInfo(accountId)).tier;
}

export function sessionLlmPolicyForTier(tier: string | null | undefined): RateLimitPolicy {
  const freeLimit = positiveInt((config as any).KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE, 60);
  const paidLimit = positiveInt((config as any).KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID, 600);
  // The multiplier is a property of the PLAN, so it comes off the plan record
  // instead of a second hand-maintained table (the legacy map that used to live
  // here is transcribed into PLAN_CATALOG.limits.llmRateMultiplier, and the
  // parity test pins the two together). A multiplier of 0 selects the FREE
  // budget rather than paid × 0 — free/none are 0 by design.
  //
  // A key that is not in the catalog keeps its historical answer of 1 (paid ×1)
  // rather than falling to `none`: this function is exported and takes an
  // arbitrary string, and silently demoting an unrecognized key to the free
  // budget would be a rate-limit change, not a refactor.
  const multiplier = getPlanRecord(tier ?? 'free')?.limits.llmRateMultiplier ?? 1;
  return {
    limit: multiplier > 0 ? paidLimit * multiplier : freeLimit,
    windowMs: 60_000,
  };
}

/**
 * Historical name for "drop the cached billing view for every account". Kept
 * because many call sites import it; it is a thin alias of
 * `invalidateAccountBilling`, which is now the single invalidation point for
 * the limit layer AND the entitlement layer (they share one cache).
 */
export function clearAccountLimitCache() {
  invalidateAccountBilling();
}
