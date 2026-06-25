'use client';

import { Button } from '@/components/ui/button';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';

interface UpgradeButtonProps {
  accountId?: string;
  className?: string;
}

export function UpgradeButton({ accountId, className }: UpgradeButtonProps) {
  const { data: accountState } = useAccountState({ accountId });
  const openUpgradeDialog = useUpgradeDialogStore((state) => state.openUpgradeDialog);

  if (!isBillingEnabled() || !accountState) return null;

  const tierKey = accountStateSelectors.tierKey(accountState).toLowerCase();
  const hasActiveSubscription = !!accountState.subscription?.subscription_id;
  const isFreeOrNoPlan = tierKey === 'free' || tierKey === 'none';

  if (!isFreeOrNoPlan || hasActiveSubscription) return null;

  const handleClick = () =>
    openUpgradeDialog({
      reason: 'subscription_required',
      accountId,
    });

  return (
    <Button type="button" className={className} onClick={handleClick}>
      Upgrade
    </Button>
  );
}
