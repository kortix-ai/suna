'use client';

import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useAccountState } from '@/hooks/billing';
import { TeamPlanDialog } from '@/components/billing/team-plan-checkout';
import { BillingAccountProvider } from '@/stores/billing-account-context';

// Global, mounted once (app-providers). The single billing modal — driven by
// the upgrade-dialog store, which the 402 handler opens. Whatever the reason,
// the upgrade is the Team plan: subscribing is the core action.
export function GlobalUpgradeDialog() {
  const { isOpen, closeUpgradeDialog, accountId } = useUpgradeDialogStore();
  // Scope to the blocked account from the 402 (e.g. the project's team account),
  // not the user's primary account — otherwise a member who owns their own
  // personal account sees `can_manage_billing: true` and an enabled CTA even
  // though they can't pay for the team. Falls back to primary when unset.
  const { data: accountState } = useAccountState({ accountId });

  return (
    // BillingAccountProvider scopes the subscribe action (useCreatePerSeatCheckout
    // reads useBillingAccountId) to the same account the state is read from.
    <BillingAccountProvider accountId={accountId ?? null}>
      <TeamPlanDialog
        open={isOpen}
        onOpenChange={(open) => !open && closeUpgradeDialog()}
        accountState={accountState}
      />
    </BillingAccountProvider>
  );
}
