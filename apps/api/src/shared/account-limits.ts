import { config } from '../config';
import { getSubscriptionInfo } from '../billing/repositories/credit-accounts';
import { getTier, isPaidTier, isPerSeatAccount, tierGrantsAllModels, MAX_PROJECTS_PER_ACCOUNT } from '../billing/services/tiers';
import type { RateLimitPolicy } from './rate-limit';

// Free accounts may own a single project. Any paid plan (pro or the per-seat
// team plan) lifts the cap to MAX_PROJECTS_PER_ACCOUNT — effectively uncapped
// for normal use. Tightening the free limit here is the one knob to turn.
export const FREE_TIER_PROJECT_LIMIT = 1;

const tierCache = new Map<string, { tier: string | null; expiresAt: number }>();

function positiveInt(value: unknown, fallback: number) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function tierMultiplier(tier: string | null | undefined) {
  const name = tier ?? 'free';
  const legacyMultipliers: Record<string, number> = {
    tier_6_50: 2,
    tier_12_100: 3,
    tier_25_200: 4,
    tier_50_400: 6,
    tier_125_800: 8,
    tier_200_1000: 10,
    tier_150_1200: 12,
  };
  return legacyMultipliers[name] ?? (name !== 'free' && name !== 'none' ? 1 : 0);
}

export async function resolveAccountTier(accountId: string): Promise<string | null> {
  const cached = tierCache.get(accountId);
  if (cached && Date.now() < cached.expiresAt) return cached.tier;

  try {
    const subscription = await getSubscriptionInfo(accountId);
    let tier = subscription?.tier ?? 'free';
    // Per-seat teams are paid by virtue of an active seat subscription, but a
    // number of rows still carry a stale tier='free' — the seat-billing
    // migration set billing_model='per_seat' without backfilling tier. Deriving
    // the paid tier from billing_model + an active subscription here means stale
    // tier data can't mis-gate paying teams as free (e.g. the 1-project cap),
    // and it self-heals every tier-based limit (projects, sessions, rate).
    if (
      !isPaidTier(tier) &&
      isPerSeatAccount(subscription?.billingModel) &&
      !!subscription?.stripeSubscriptionId &&
      subscription.stripeSubscriptionStatus !== 'canceled' &&
      subscription.stripeSubscriptionStatus !== 'unpaid'
    ) {
      tier = 'per_seat';
    }
    tierCache.set(accountId, { tier, expiresAt: Date.now() + 60_000 });
    return tier;
  } catch {
    return 'free';
  }
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
  const tier = await resolveAccountTier(accountId);
  return tierGrantsAllModels(tier ?? 'free');
}

export function sessionLlmPolicyForTier(tier: string | null | undefined): RateLimitPolicy {
  const freeLimit = positiveInt((config as any).KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE, 60);
  const paidLimit = positiveInt((config as any).KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID, 600);
  const multiplier = tierMultiplier(tier);
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

/**
 * Maximum number of projects an account may own, by plan. Free → 1; any paid
 * tier → MAX_PROJECTS_PER_ACCOUNT. When billing isn't active (local /
 * self-hosted) the cap is lifted entirely, mirroring
 * maxConcurrentSessionsForTier so a missing subscription can't kneecap
 * project creation.
 */
export async function maxProjectsForAccount(accountId: string): Promise<number> {
  if (!(config as any).KORTIX_BILLING_INTERNAL_ENABLED) {
    return Number.MAX_SAFE_INTEGER;
  }
  const tier = await resolveAccountTier(accountId);
  return isPaidTier(tier ?? 'free') ? MAX_PROJECTS_PER_ACCOUNT : FREE_TIER_PROJECT_LIMIT;
}

export function clearAccountLimitCache() {
  tierCache.clear();
}
