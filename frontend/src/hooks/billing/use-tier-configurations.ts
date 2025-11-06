import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface TierConfiguration {
  tier_key: string;
  name: string;
  display_name: string;
  monthly_credits: number;
  can_purchase_credits: boolean;
  project_limit: number;
  price_ids: string[];  // Backend-only: kept for API response compatibility, frontend should use tier_key
}

export interface TierConfigurationsResponse {
  success: boolean;
  tiers: TierConfiguration[];
  timestamp: string;
}

/**
 * Fetch tier configurations from the backend API
 * This is the SINGLE SOURCE OF TRUTH for tier configurations
 */
async function fetchTierConfigurations(): Promise<TierConfigurationsResponse> {
  const response = await backendApi.get<TierConfigurationsResponse>(
    '/billing/tier-configurations'
  );
  return response.data;
}

export function useTierConfigurations() {
  return useQuery({
    queryKey: ['tier-configurations'],
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

