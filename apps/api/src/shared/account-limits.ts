import { config } from '../config';
import { getSubscriptionInfo } from '../billing/repositories/credit-accounts';
import { invalidateAccountBilling, resolveAccountBilling } from '../billing/services/billing-cache';
import {
  activeTrialSeatLimit,
  coercePerSeatTier,
  type SubscriptionFields,
} from '../billing/services/effective-tier';
import { accountMayUseManagedModels } from '../billing/services/entitlements';
import { getPlanRecord } from '../billing/services/plan-catalog';
import { getTier, isPaidTier, MAX_PROJECTS_PER_ACCOUNT } from '../billing/services/tiers';
import type { RateLimitPolicy } from './rate-limit';

// Managed cloud is paid-only: new accounts resolve to tier 'none' and must
// subscribe before creating projects. This cap governs any legacy/backwards-compat
// free account; any paid plan lifts it to MAX_PROJECTS_PER_ACCOUNT, and Enterprise
// is uncapped (see maxProjectsForAccount).
//
// One project per free account. Sign-up auto-provisions exactly one, so a free
// account's single slot is filled the moment it exists and "create another
// project" is a paid action. Archived projects do not consume the slot (see
// enforceProjectQuota), so deleting the one project frees it again.
export const FREE_TIER_PROJECT_LIMIT = 1;

type AccountLimitInfo = {
  tier: string | null;
  /** Operator-set credit_accounts.max_concurrent_sessions; null = no override. */
  sessionOverride: number | null;
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
 * The effective plan = active trial overlay > per-seat self-heal > stored tier.
 * The self-heal keeps stale tier='free' per-seat rows from mis-gating paying
 * teams; the trial overlay lets an admin-issued trial lift project/session/rate
 * limits for exactly the trial window.
 */
async function resolveAccountLimitInfo(
  accountId: string,
  options: { useCache?: boolean } = {},
): Promise<AccountLimitInfo> {
  try {
    const resolved = await resolveAccountBilling(accountId, { fresh: options.useCache === false });
    return {
      // No credit row at all reads as 'free' HERE (not 'none'): the limit layer
      // has always treated an unprovisioned account as free rather than
      // fail-closing it out of its one project. Entitlement gates fail closed
      // to 'none' instead — a different question, deliberately.
      tier: resolved.source === 'no_account' ? 'free' : resolved.plan.key,
      sessionOverride:
        resolved.limits.concurrentSessions.source === 'account_override'
          ? resolved.limits.concurrentSessions.value
          : null,
    };
  } catch {
    return { tier: 'free', sessionOverride: null };
  }
}

export async function resolveAccountTier(accountId: string): Promise<string | null> {
  return (await resolveAccountLimitInfo(accountId)).tier;
}

/**
 * Whether to mount the premium LLM gateway (the `kortix` provider, with
 * Claude/GPT/Gemini/…) for an account at sandbox-provision time. When false the
 * sandbox boots with only OpenCode's built-in Zen catalog.
 *
 * This is purely the *entitlement* layer — "is this account allowed to SEE
 * premium models". Per-request affordability (active seat sub / wallet balance)
 * is enforced separately by the gateway itself (assertBillingActive +
 * deductForLlmUsage), so we deliberately do NOT re-check credits here: a paid
 * account that has run dry still sees the models and gets a clear "top up" 402
 * on use, rather than silently being shown a stripped-down Zen-only list.
 *
 * - billing off (local / self-hosted): always entitled — the gateway
 *   records-but-never-debits there.
 * - billing on: entitled iff the resolved tier grants all models. This covers
 *   per-seat teams AND every legacy paid tier (pro, tier_*), all of which carry
 *   models:['all']. resolveAccountTier already self-heals stale per-seat rows and
 *   falls back to 'free' on error, so the safe default is "no gateway".
 */
export async function accountEntitledToLlmGateway(accountId: string): Promise<boolean> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return true;
  // Single source of truth for "may this account use managed models" — trial
  // overlay and the operator managed_models_override included (entitlements.ts).
  return accountMayUseManagedModels(accountId);
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

export function maxConcurrentSessionsForTier(tier: string | null | undefined) {
  // When billing isn't active (local / self-hosted), the tier system is
  // a no-op — return an effectively-unlimited cap so a missing
  // subscription doesn't kneecap session creation.
  if (!(config as any).KORTIX_BILLING_INTERNAL_ENABLED) {
    return Number.MAX_SAFE_INTEGER;
  }
  // Tier definition is the source of truth for concurrent session caps.
  // Fall back to free-tier cap for unknown tiers.
  return getTier(tier ?? 'free').concurrentSessionLimit;
}

export type AccountSessionLimit = {
  tier: string | null;
  limit: number;
  /** Where the limit came from — drives audit metadata and support triage. */
  source: 'tier' | 'account_override' | 'billing_disabled';
};

/**
 * Concurrent-session cap for an account. Resolution order:
 *   1. billing off (local / self-hosted) → effectively unlimited;
 *   2. credit_accounts.max_concurrent_sessions (operator-set per-account
 *      override, e.g. enterprise deals or our own dogfood account) → wins over
 *      the tier in both directions;
 *   3. the plan tier's TierConfig.concurrentSessionLimit.
 * This path reads FRESH (`useCache: false`), deliberately bypassing the shared
 * 30s billing cache. Session requests can reach different API tasks, so local
 * cache invalidation cannot make an operator override consistent across the
 * deployment.
 */
export async function resolveAccountSessionLimit(accountId: string): Promise<AccountSessionLimit> {
  if (!(config as any).KORTIX_BILLING_INTERNAL_ENABLED) {
    return { tier: null, limit: Number.MAX_SAFE_INTEGER, source: 'billing_disabled' };
  }
  const { tier, sessionOverride } = await resolveAccountLimitInfo(accountId, { useCache: false });
  if (sessionOverride !== null) {
    return { tier, limit: sessionOverride, source: 'account_override' };
  }
  return { tier, limit: maxConcurrentSessionsForTier(tier), source: 'tier' };
}

/**
 * Maximum number of projects an account may own, by plan:
 *   Free        → FREE_TIER_PROJECT_LIMIT (1)
 *   Team/legacy → MAX_PROJECTS_PER_ACCOUNT (200)
 *   Enterprise  → uncapped (negotiated)
 * When billing isn't active (local / self-hosted) the cap is lifted entirely,
 * mirroring maxConcurrentSessionsForTier so a missing subscription can't
 * kneecap project creation.
 */
export async function maxProjectsForAccount(accountId: string): Promise<number> {
  if (!(config as any).KORTIX_BILLING_INTERNAL_ENABLED) {
    return Number.MAX_SAFE_INTEGER;
  }
  // Project creation can land on a different API task than the checkout that
  // upgraded the account. A per-process cached free-tier answer must not reject
  // a just-funded account on that other task, so quota enforcement reads the
  // shared billing source fresh, matching the cross-task consistency contract
  // already used by session limits above.
  const tier = (await resolveAccountLimitInfo(accountId, { useCache: false })).tier ?? 'free';
  // Exact plan-KEY equality, matching what this code did before the resolver
  // landed. `PLAN_CATALOG.enterprise` is the only key in the `enterprise`
  // family today, so key- and family-equality agree; widening this to
  // `record.family === 'enterprise'` (or to an uncapped-projects entitlement)
  // is a product decision for when a second enterprise-family plan exists, not
  // a side effect of this refactor.
  if (tier === 'enterprise') return Number.MAX_SAFE_INTEGER;
  return isPaidTier(tier) ? MAX_PROJECTS_PER_ACCOUNT : FREE_TIER_PROJECT_LIMIT;
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

/**
 * The tier the LIMIT layer will actually use, given possibly-stale tier data.
 *
 * `resolveAccountSessionLimit` coerces a paying per-seat account whose stored
 * `tier` is not a paid one to `per_seat`, so stale tier data cannot gate a
 * paying team as free. Anything that DISPLAYS a tier-derived limit has to apply
 * the same rule or it shows a different number than the server enforces —
 * exported here so there is one derivation instead of two.
 */
export function effectiveTierForLimits(
  tier: string | null | undefined,
  subscription: SubscriptionFields | null | undefined,
): string {
  return coercePerSeatTier(tier ?? 'free', subscription);
}

/**
 * Seat allowance for an account while an admin-issued trial is active.
 * null = no active trial or the trial is uncapped — no trial seat gate.
 * Reads uncached: member-add/invite is rare and must see a just-granted or
 * just-revoked trial immediately across API tasks.
 */
export async function resolveTrialSeatLimit(accountId: string): Promise<number | null> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return null;
  try {
    const subscription = await getSubscriptionInfo(accountId);
    return activeTrialSeatLimit(subscription);
  } catch {
    return null;
  }
}
