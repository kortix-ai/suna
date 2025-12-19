'use client';

import { useCallback } from 'react';
import { useSubscriptionStore } from '@/stores/subscription-store';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { isLocalMode } from '@/lib/config';
import { toast } from 'sonner';

interface UseDownloadRestrictionOptions {
  /** Custom feature name for the toast message (e.g., "files", "presentations", "images") */
  featureName?: string;
}

interface UseDownloadRestrictionReturn {
  /** Whether the user is on a free tier and downloads should be restricted */
  isRestricted: boolean;
  /** Wrapper function that checks restriction before executing callback */
  withRestrictionCheck: <T extends (...args: any[]) => any>(callback: T) => (...args: Parameters<T>) => ReturnType<T> | void;
  /** Manually show upgrade prompt (toast + modal) */
  showUpgradePrompt: () => void;
  /** Alias for showUpgradePrompt for backward compatibility */
  openUpgradeModal: () => void;
}

/**
 * Hook to restrict downloads/exports for free tier users.
 * Shows a toast notification when a restricted action is attempted.
 * 
 * Usage:
 * ```tsx
 * const { isRestricted, withRestrictionCheck, showUpgradePrompt } = useDownloadRestriction({
 *   featureName: 'presentations'
 * });
 * 
 * // Wrap your download handler
 * const handleDownload = withRestrictionCheck(() => {
 *   // actual download logic
 * });
 * 
 * // Or check manually
 * const handleDownload = () => {
 *   if (isRestricted) {
 *     showUpgradePrompt();
 *     return;
 *   }
 *   // actual download logic
 * };
 * ```
 */
export function useDownloadRestriction(options?: UseDownloadRestrictionOptions): UseDownloadRestrictionReturn {
  const accountState = useSubscriptionStore((state) => state.accountState);
  const { openPricingModal } = usePricingModalStore();

  // Check if user is on free tier
  const isFreeTier = accountState && (
    accountState.subscription.tier_key === 'free' ||
    accountState.subscription.tier_key === 'none' ||
    !accountState.subscription.tier_key
  );

  // Downloads are restricted if user is on free tier and NOT in local mode
  const isRestricted = isFreeTier && !isLocalMode();

  const showUpgradePrompt = useCallback(() => {
    const featureName = options?.featureName || 'files';
    
    // Show toast notification at top center
    toast.error(`Upgrade to download ${featureName}`, {
      description: 'Downloads are available on paid plans.',
      position: 'top-center',
      duration: 5000,
    });
    
    // Also open the pricing modal
    openPricingModal({
      isAlert: true,
      alertTitle: 'Upgrade to Download',
      alertSubtitle: `Export and download features are available on paid plans. Upgrade now to download your ${featureName} and more.`,
    });
  }, [openPricingModal, options?.featureName]);

  const withRestrictionCheck = useCallback(<T extends (...args: any[]) => any>(callback: T) => {
    return (...args: Parameters<T>): ReturnType<T> | void => {
      if (isRestricted) {
        showUpgradePrompt();
        return;
      }
      return callback(...args);
    };
  }, [isRestricted, showUpgradePrompt]);

  return {
    isRestricted,
    withRestrictionCheck,
    showUpgradePrompt,
    // Keep openUpgradeModal as alias for backward compatibility
    openUpgradeModal: showUpgradePrompt,
  };
}

// Re-export with old name for backward compatibility
export { useDownloadRestriction as useDownloadRestrictionHook };






