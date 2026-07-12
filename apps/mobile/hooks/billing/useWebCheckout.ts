/**
 * useWebCheckout — mobile has no in-app payment. The upgrade opens the backend's
 * masked kortix.com checkout in an in-app browser (`startPlanCheckout`), and the
 * web redirects back to `agentpress://billing/success`, which auto-closes the
 * browser. On return we invalidate the account/billing state so the new plan
 * shows immediately, and toast the outcome.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { startPlanCheckout, startCreditPurchase, openBillingPortal } from '@/lib/billing/checkout';
import { invalidateAccountState } from '@/lib/billing/hooks';
import { useToast } from '@/components/ui/toast-provider';
import { log } from '@/lib/logger';

type Commitment = 'monthly' | 'yearly' | 'yearly_commitment';

export function useWebCheckout() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pendingTier, setPendingTier] = useState<string | null>(null);
  const [pendingCredits, setPendingCredits] = useState(false);

  /** Refetch subscription/tier so the UI reflects the new plan. */
  const refreshBilling = useCallback(() => {
    invalidateAccountState(queryClient);
  }, [queryClient]);

  const upgradeToPlan = useCallback(
    async (tierKey: string, commitmentType: Commitment = 'monthly') => {
      if (pendingTier) return;
      setPendingTier(tierKey);
      try {
        await startPlanCheckout(
          tierKey,
          commitmentType,
          () => {
            refreshBilling();
            toast.success('Subscription updated');
          },
          () => {
            // user cancelled — nothing to do
          }
        );
      } catch (err: any) {
        log.error('Web plan checkout failed:', err);
        toast.error(err?.message || 'Could not open checkout. Please try again.');
      } finally {
        setPendingTier(null);
      }
    },
    [pendingTier, refreshBilling, toast]
  );

  const purchaseCredits = useCallback(
    async (amount: number) => {
      if (pendingCredits) return;
      setPendingCredits(true);
      try {
        await startCreditPurchase(amount, () => {
          refreshBilling();
          toast.success('Credits added');
        });
      } catch (err: any) {
        log.error('Web credit purchase failed:', err);
        toast.error(err?.message || 'Could not open checkout. Please try again.');
      } finally {
        setPendingCredits(false);
      }
    },
    [pendingCredits, refreshBilling, toast]
  );

  /** Manage billing (cancel / invoices / reactivate) on the web. */
  const openManageBilling = useCallback(async () => {
    try {
      await openBillingPortal();
    } catch (err) {
      log.error('Open billing portal failed:', err);
      toast.error('Could not open billing management.');
    }
  }, [toast]);

  return {
    upgradeToPlan,
    purchaseCredits,
    openManageBilling,
    refreshBilling,
    pendingTier,
    pendingCredits,
    /** true while any checkout is opening. */
    isCheckingOut: pendingTier !== null || pendingCredits,
  };
}
