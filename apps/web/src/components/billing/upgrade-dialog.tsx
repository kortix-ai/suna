'use client';

import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useAccountState } from '@/hooks/billing';
import { TeamPlanDialog } from '@/components/billing/team-plan-checkout';

// Global, mounted once (app-providers). The single billing modal — driven by
// the upgrade-dialog store, which the 402 handler opens. Whatever the reason,
// the upgrade is the Team plan: subscribing is the core action.
export function GlobalUpgradeDialog() {
  const { isOpen, closeUpgradeDialog } = useUpgradeDialogStore();
  const { data: accountState } = useAccountState();

  return (
    <TeamPlanDialog
      open={isOpen}
      onOpenChange={(open) => !open && closeUpgradeDialog()}
      accountState={accountState}
    />
  );
}
