/**
 * useUpgradePaywall Hook
 *
 * Determines whether to use RevenueCat paywall or custom plan page.
 * Presents the appropriate paywall based on current subscription tier:
 * - No subscription → Plus Paywall
 * - Plus subscription → Pro Paywall
 * - Pro subscription → Ultra Paywall
 * - Ultra subscription → Topups Paywall (one-time purchases)
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import Purchases from 'react-native-purchases';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { presentPaywall } from '@/lib/billing/revenuecat';
import { invalidateAccountState } from '@/lib/billing/hooks';
import { useSubscription } from '@/lib/billing';
import { useAuthContext } from '@/contexts';

/**
 * Debug helper to log all available offerings from RevenueCat
 * Call this to see what offering identifiers are available
 */
export async function logAvailablePaywalls(): Promise<string[]> {
  try {
    const offerings = await Purchases.getOfferings();
    const offeringIds = Object.keys(offerings.all);
    console.log('📦 Available RevenueCat offerings:', offeringIds);
    console.log('📦 Current offering:', offerings.current?.identifier || 'none');
    return offeringIds;
  } catch (error) {
    console.error('❌ Error fetching offerings:', error);
    return [];
  }
}

/**
 * Paywall names in RevenueCat based on subscription tier
 * These must match the offering identifiers in RevenueCat exactly
 */
export const PAYWALL_NAMES = {
  /** Shown when user has no subscription - offers Plus plan */
  PLUS: 'plus',
  /** Shown when user has Plus subscription - offers Pro plan */
  PRO: 'pro',
  /** Shown when user has Pro subscription - offers Ultra plan */
  ULTRA: 'ultra',
  /** Shown when user has Ultra subscription - offers credit top-ups (one-time purchases) */
  TOPUPS: 'topups',
} as const;

export type PaywallName = (typeof PAYWALL_NAMES)[keyof typeof PAYWALL_NAMES];

/**
 * Tier key to next paywall mapping
 */
const TIER_TO_PAYWALL: Record<string, PaywallName> = {
  free: PAYWALL_NAMES.PLUS,
  none: PAYWALL_NAMES.PLUS,
  tier_2_20: PAYWALL_NAMES.PRO,
  tier_6_50: PAYWALL_NAMES.ULTRA,
  tier_25_200: PAYWALL_NAMES.TOPUPS,
};

/**
 * Determines which paywall to show based on current subscription tier
 */
export function getPaywallForTier(tierKey: string | undefined | null): PaywallName {
  if (!tierKey || tierKey === 'free' || tierKey === 'none') {
    return PAYWALL_NAMES.PLUS;
  }
  return TIER_TO_PAYWALL[tierKey] || PAYWALL_NAMES.PLUS;
}

/**
 * Checks if the current tier should show topups instead of subscription upgrade
 */
export function isTopupsTier(tierKey: string | undefined | null): boolean {
  return tierKey === 'tier_25_200';
}

export interface UpgradePaywallResult {
  /** Whether RevenueCat paywall should be used (true) or custom page (false) */
  useNativePaywall: boolean;
  /** Current paywall that will be shown based on subscription tier */
  currentPaywallName: PaywallName;
  /** Whether the user is on Ultra tier and should see topups */
  isOnUltraTier: boolean;
  /** Function to present the upgrade paywall. Returns true if purchase was successful. */
  presentUpgradePaywall: () => Promise<{
    purchased: boolean;
    cancelled: boolean;
  }>;
}

/**
 * Hook to handle upgrade paywall presentation.
 *
 * If RevenueCat is available on the platform, it will present the native
 * RevenueCat paywall directly. Otherwise, returns useNativePaywall=false
 * to indicate the custom PlanPage should be shown.
 *
 * The paywall shown depends on the user's current subscription tier:
 * - No subscription → Plus Paywall
 * - Plus → Pro Paywall
 * - Pro → Ultra Paywall
 * - Ultra → Topups Paywall
 */
export function useUpgradePaywall(): UpgradePaywallResult {
  const queryClient = useQueryClient();
  const { user } = useAuthContext();
  const { data: subscriptionData, refetch: refetchSubscription } = useSubscription({
    enabled: !!user,
  });

  const useRevenueCat = shouldUseRevenueCat() && isRevenueCatConfigured();

  // Get current tier key from subscription data
  const tierKey = subscriptionData?.tier_key || subscriptionData?.subscription?.tier_key;

  // Determine which paywall to show based on tier
  const currentPaywallName = getPaywallForTier(tierKey);
  const isOnUltraTier = isTopupsTier(tierKey);

  const presentUpgradePaywall = useCallback(async () => {
    if (!useRevenueCat) {
      // If RevenueCat is not available, return cancelled so caller shows custom page
      return { purchased: false, cancelled: true };
    }

    try {
      // Determine paywall based on current subscription tier
      const paywallToShow = getPaywallForTier(tierKey);
      console.log(
        `📱 Presenting RevenueCat paywall: ${paywallToShow} (current tier: ${tierKey || 'none'})`
      );

      const result = await presentPaywall(paywallToShow);

      if (result.purchased) {
        console.log('✅ Purchase completed from paywall');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // Invalidate cache and refetch subscription data
        invalidateAccountState(queryClient);
        await refetchSubscription();
      } else if (result.cancelled) {
        console.log('🚫 User cancelled paywall');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        console.log('ℹ️ Paywall was dismissed without purchase');
      }

      return result;
    } catch (error: any) {
      console.error('❌ Error presenting paywall:', error?.message || error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return { purchased: false, cancelled: true };
    }
  }, [useRevenueCat, queryClient, refetchSubscription, tierKey]);

  return {
    useNativePaywall: useRevenueCat,
    currentPaywallName,
    isOnUltraTier,
    presentUpgradePaywall,
  };
}
