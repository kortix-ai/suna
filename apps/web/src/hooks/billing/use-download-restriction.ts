'use client';

import { errorToast } from '@/components/ui/toast';
import { isBillingEnabled } from '@/lib/config';
import { useSubscriptionStore } from '@/stores/subscription-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { resolvedPlan } from '@kortix/sdk';
import { useTranslations } from '@/i18n/use-translations';
import { useCallback } from 'react';

interface UseDownloadRestrictionOptions {
  /** Custom feature name for the toast message (e.g., "files", "presentations", "images") */
  featureName?: string;
}

interface UseDownloadRestrictionReturn {
  /** Whether the user is on a free tier and downloads should be restricted */
  isRestricted: boolean;
  /** Manually show upgrade prompt (toast + modal) */
  openUpgradeModal: () => void;
}

/**
 * Hook to restrict downloads/exports for free tier users.
 * Shows a toast notification when a restricted action is attempted.
 *
 * Usage:
 * ```tsx
 * const { isRestricted, openUpgradeModal } = useDownloadRestriction({
 *   featureName: 'presentations'
 * });
 *
 * // Check manually
 * const handleDownload = () => {
 *   if (isRestricted) {
 *     openUpgradeModal();
 *     return;
 *   }
 *   // actual download logic
 * };
 * ```
 */
export function useDownloadRestriction(
  options?: UseDownloadRestrictionOptions,
): UseDownloadRestrictionReturn {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const accountState = useSubscriptionStore((state) => state.accountState);
  const { openUpgradeDialog } = useUpgradeDialogStore();

  // The RESOLVED plan family — `free` and `none` are the only two keys in it,
  // so this covers the same plans the tier_key compare did, and additionally
  // stops restricting downloads for an account on an admin trial (stored
  // tier_key `free`, but paid everywhere the server enforces).
  const isFreeTier = accountState?.subscription
    ? resolvedPlan(accountState).family === 'free'
    : undefined;

  // Downloads are restricted if user is on free tier and billing is enabled
  const isRestricted = isFreeTier && isBillingEnabled();

  const showUpgradePrompt = useCallback(() => {
    const featureName = options?.featureName || 'files';

    // Show toast notification at top center
    errorToast(tI18nComplete('texte2add2aa32a0', { value0: featureName }), {
      description: tI18nComplete.raw('text332f54c83d00'),
      position: 'top-center',
      duration: 5000,
    });

    // Also open the upgrade modal. This used to target the pricing-modal
    // store, whose modal is never mounted, so only the toast ever appeared.
    openUpgradeDialog({
      reason: 'subscription_required',
      message: tI18nComplete('textc6c90c48b495', { value0: featureName }),
    });
  }, [openUpgradeDialog, options?.featureName, tI18nComplete]);

  return {
    isRestricted: isRestricted ?? false,
    openUpgradeModal: showUpgradePrompt,
  };
}
