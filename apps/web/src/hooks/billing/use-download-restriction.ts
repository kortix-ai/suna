'use client';

import { errorToast } from '@/components/ui/toast';
import { isBillingEnabled } from '@/lib/config';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useSubscriptionStore } from '@/stores/subscription-store';
import { useCallback } from 'react';

interface UseDownloadRestrictionOptions {
  /** Custom feature name for the toast message (e.g., "files", "presentations", "images") */
  featureName?: string;
}

interface UseDownloadRestrictionReturn {
  /** Whether the user is on a free tier and downloads should be restricted */
  isRestricted: boolean;
  /** Wrapper function that checks restriction before executing callback */
  withRestrictionCheck: <T extends (...args: any[]) => any>(
    callback: T,
  ) => (...args: Parameters<T>) => ReturnType<T> | void;
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
export function useDownloadRestriction(
  options?: UseDownloadRestrictionOptions,
): UseDownloadRestrictionReturn {
  const accountState = useSubscriptionStore((state) => state.accountState);
  const { openPricingModal } = usePricingModalStore();

  const isFreeTier =
    accountState?.subscription &&
    (accountState.subscription.tier_key === 'free' ||
      accountState.subscription.tier_key === 'none' ||
      !accountState.subscription.tier_key);

  // Downloads are restricted if user is on free tier and billing is enabled
  const isRestricted = isFreeTier && isBillingEnabled();

  const showUpgradePrompt = useCallback(() => {
    const featureName = options?.featureName || 'files';

    // Show toast notification at top center
    errorToast(`Upgrade to download ${featureName}`, {
      description: 'Downloads are available on paid plans.',
      position: 'top-center',
      duration: 5000,
    });

    // Also open the pricing modal
    openPricingModal({
      isAlert: true,
      alertTitle: `Upgrade to download your ${featureName} and more`,
    });
  }, [openPricingModal, options?.featureName]);

  const withRestrictionCheck = useCallback(
    <T extends (...args: any[]) => any>(callback: T) => {
      return (...args: Parameters<T>): ReturnType<T> | void => {
        if (isRestricted) {
          showUpgradePrompt();
          return;
        }
        return callback(...args);
      };
    },
    [isRestricted, showUpgradePrompt],
  );

  return {
    isRestricted: isRestricted ?? false,
    withRestrictionCheck,
    showUpgradePrompt,
    // Keep openUpgradeModal as alias for backward compatibility
    openUpgradeModal: showUpgradePrompt,
  };
}

// Re-export with old name for backward compatibility
export { useDownloadRestriction as useDownloadRestrictionHook };
