'use client';

import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useAccountState } from '@/hooks/billing';
import { TeamPlanCheckout } from '@/features/billing/team-plan-checkout';
import { BillingAccountProvider } from '@/stores/billing-account-context';

export function GlobalUpgradeModal() {
  const { isOpen, closeUpgradeDialog, accountId } = useUpgradeDialogStore();
  const { data: accountState } = useAccountState({ accountId });

  return (
    <BillingAccountProvider accountId={accountId ?? null}>
      <TeamPlanCheckout
        open={isOpen}
        onOpenChange={(open) => !open && closeUpgradeDialog()}
        accountState={accountState}
      />
    </BillingAccountProvider>
  );
}
