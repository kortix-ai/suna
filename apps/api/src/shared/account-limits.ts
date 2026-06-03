import { config } from '../config';
import { getSubscriptionInfo } from '../billing/repositories/credit-accounts';
import { getTier } from '../billing/services/tiers';

const tierCache = new Map<string, { tier: string | null; expiresAt: number }>();

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
