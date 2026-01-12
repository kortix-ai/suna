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

import { log } from '@/lib/logger';
import { useCallback } from 'react';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import Purchases from 'react-native-purchases';
import { shouldUseRevenueCat } from '@/lib/billing/provider';
import { presentPaywall } from '@/lib/billing/revenuecat';
import { invalidateAccountState, accountStateKeys, useAccountState } from '@/lib/billing/hooks';
import { useSubscription } from '@/lib/billing';
import { useAuthContext, useBillingContext } from '@/contexts';

/**
 * Debug helper to log all available offerings from RevenueCat
 * Call this to see what offering identifiers are available
 */
export async function logAvailablePaywalls(): Promise<string[]> {
  try {
    const offerings = await Purchases.getOfferings();
    const offeringIds = Object.keys(offerings.all);
    log.log('📦 Available RevenueCat offerings:', offeringIds);
    log.log('📦 Current offering:', offerings.current?.identifier || 'none');
    return offeringIds;
  } catch (error) {
    log.error('❌ Error fetching offerings:', error);
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
  const { refetchAll: refetchAllBilling } = useBillingContext();
  const { data: subscriptionData, refetch: refetchSubscription } = useSubscription({
    enabled: !!user,
  });
  // Also get account state directly to ensure we use backend data, not RevenueCat
  const { data: accountState } = useAccountState({
    enabled: !!user,
  });

  const useRevenueCat = shouldUseRevenueCat();

  // Get current tier key from backend account-state (source of truth), not RevenueCat
  // This ensures we show the correct upgrade option even if RevenueCat hasn't synced yet
  const tierKey =
    accountState?.subscription?.tier_key ||
    subscriptionData?.tier_key ||
    subscriptionData?.subscription?.tier_key;

  // Debug logging to help troubleshoot tier detection
  React.useEffect(() => {
    log.log('🔍 [UPGRADE_PAYWALL] Tier detection:', {
      accountStateTier: accountState?.subscription?.tier_key,
      subscriptionDataTier: subscriptionData?.tier_key,
      subscriptionTier: subscriptionData?.subscription?.tier_key,
      finalTierKey: tierKey,
      paywallToShow: getPaywallForTier(tierKey),
    });
  }, [accountState?.subscription?.tier_key, subscriptionData?.tier_key, tierKey]);

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
      log.log(
        `📱 Presenting RevenueCat paywall: ${paywallToShow} (current tier: ${tierKey || 'none'})`
      );

      const result = await presentPaywall(paywallToShow);

      if (result.purchased) {
        log.log('✅ Purchase completed from paywall');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // Force immediate refetch of all billing data
        // Remove queries from cache to force fresh fetch
        queryClient.removeQueries({ queryKey: accountStateKeys.all });

        // Wait a moment for backend to process the purchase
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Force refetch all billing queries with retry logic
        const refetchWithRetry = async (retries = 3) => {
          for (let i = 0; i < retries; i++) {
            try {
              // Force refetch by removing cache and fetching fresh
              const results = await Promise.all([
                refetchSubscription(),
                queryClient.refetchQueries({
                  queryKey: accountStateKeys.all,
                  type: 'active', // Only refetch active queries
                }),
              ]);

              // Check if subscription data was updated
              const updatedData = queryClient.getQueryData(accountStateKeys.state());
              if (updatedData) {
                const tierKey = (updatedData as any)?.subscription?.tier_key;
                log.log(`🔄 Billing data refreshed after purchase (tier: ${tierKey})`);
                break;
              }

              // If not updated and we have retries left, wait and try again
              if (i < retries - 1) {
                log.log(`⏳ Waiting for backend sync, retry ${i + 1}/${retries}...`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            } catch (error) {
              log.warn('⚠️ Error refetching billing data:', error);
              if (i < retries - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }
          }
        };

        await refetchWithRetry();

        // Also trigger BillingContext refetch to update all components
        refetchAllBilling();
      } else if (result.cancelled) {
        log.log('🚫 User cancelled paywall');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        log.log('ℹ️ Paywall was dismissed without purchase');
      }

      return result;
    } catch (error: any) {
      // Log detailed error information for debugging
      log.error('❌ Error presenting paywall:', error?.message || error);
      
      // Check for specific error codes that indicate we should fall back to custom page
      const shouldFallback = 
        error?.code === 'NO_PAYWALL_TEMPLATE' ||
        error?.code === 'CONFIGURATION_ERROR' ||
        error?.code === 'OFFERING_NOT_FOUND' ||
        error?.code === 'PAYWALL_NOT_FOUND' ||
        error?.code === 'NO_OFFERINGS';
      
      if (shouldFallback) {
        log.warn('⚠️ RevenueCat paywall unavailable, should use custom plan page');
        log.warn('📋 Configuration details:', {
          paywallName: getPaywallForTier(tierKey),
          currentTier: tierKey,
          errorCode: error?.code,
          availableOfferings: error?.availableOfferings,
        });
        // Return a special result indicating we need the custom page
        return { purchased: false, cancelled: true, needsCustomPage: true } as any;
      }
      
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return { purchased: false, cancelled: true };
    }
  }, [useRevenueCat, queryClient, refetchSubscription, refetchAllBilling, tierKey]);

  return {
    useNativePaywall: useRevenueCat,
    currentPaywallName,
    isOnUltraTier,
    presentUpgradePaywall,
  };
}
