import { useQuery } from '@tanstack/react-query';
import { accountStateKeys } from './use-account-state';
import { getBillingTierConfigurations } from '@kortix/sdk';

export type TierConfigurationsResponse = Awaited<
  ReturnType<typeof getBillingTierConfigurations>
>;
export type TierConfiguration = TierConfigurationsResponse['tiers'][number];

/**
 * Fetch tier configurations from the backend API
 * This is the SINGLE SOURCE OF TRUTH for tier configurations
 */
async function fetchTierConfigurations(): Promise<TierConfigurationsResponse> {
  const response = await getBillingTierConfigurations();
  return response;
}

export function useTierConfigurations() {
  return useQuery({
    queryKey: [...accountStateKeys.all, 'tier-configurations'],
    queryFn: fetchTierConfigurations,
    staleTime: 1000 * 60 * 60, // 1 hour - tier configs don't change often
    gcTime: 1000 * 60 * 60 * 24, // 24 hours (formerly cacheTime)
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  });
}

/**
 * Helper function to get a tier configuration by tier key
 */
export function getTierByKey(
  tiers: TierConfiguration[] | undefined,
  tierKey: string
): TierConfiguration | undefined {
  return tiers?.find((tier) => tier.tier_key === tierKey);
}
