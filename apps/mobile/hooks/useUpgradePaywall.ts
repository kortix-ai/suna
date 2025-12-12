/**
 * useUpgradePaywall Hook
 *
 * Determines whether to use RevenueCat paywall or custom plan page.
 * If RevenueCat is available, presents the native paywall directly.
 * Otherwise, indicates that the custom PlanPage should be shown.
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { presentPaywall } from '@/lib/billing/revenuecat';
import { invalidateAccountState } from '@/lib/billing/hooks';
import { useSubscription } from '@/lib/billing';
import { useAuthContext } from '@/contexts';

export interface UpgradePaywallResult {
  /** Whether RevenueCat paywall should be used (true) or custom page (false) */
  useNativePaywall: boolean;
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
 */
export function useUpgradePaywall(): UpgradePaywallResult {
  const queryClient = useQueryClient();
  const { user } = useAuthContext();
  const { refetch: refetchSubscription } = useSubscription({ enabled: !!user });

  const useRevenueCat = shouldUseRevenueCat() && isRevenueCatConfigured();

  const presentUpgradePaywall = useCallback(async () => {
    if (!useRevenueCat) {
      // If RevenueCat is not available, return cancelled so caller shows custom page
      return { purchased: false, cancelled: true };
    }

    try {
      console.log('📱 Presenting RevenueCat paywall: Main Paywall');
      const result = await presentPaywall('Main Paywall');

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
      console.error('❌ Error presenting paywall:', error);
      return { purchased: false, cancelled: true };
    }
  }, [useRevenueCat, queryClient, refetchSubscription]);

  return {
    useNativePaywall: useRevenueCat,
    presentUpgradePaywall,
  };
}
