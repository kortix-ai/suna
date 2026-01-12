/**
 * RevenueCat Pricing Hook
 * 
 * React hook to load and manage RevenueCat pricing data
 */

import { useQuery } from '@tanstack/react-query';
import { getRevenueCatPricing, type RevenueCatPricingData } from '@/lib/billing/revenuecat-pricing';
import { shouldUseRevenueCat } from '@/lib/billing/provider';

const REVENUECAT_PRICING_KEY = ['revenuecat', 'pricing'];

export function useRevenueCatPricing() {
  const useRevenueCat = shouldUseRevenueCat();
  
  return useQuery<Map<string, RevenueCatPricingData>>({
    queryKey: REVENUECAT_PRICING_KEY,
    queryFn: getRevenueCatPricing,
    enabled: useRevenueCat,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  });
}









