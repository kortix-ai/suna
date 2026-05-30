import { config } from '../config';
import { getSubscriptionInfo } from '../billing/repositories/credit-accounts';
import { getTier } from '../billing/services/tiers';
import type { RateLimitPolicy } from './rate-limit';

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
    const tier = subscription?.tier ?? 'free';
    tierCache.set(accountId, { tier, expiresAt: Date.now() + 60_000 });
    return tier;
  } catch {
    return 'free';
  }
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

export function clearAccountLimitCache() {
  tierCache.clear();
}
