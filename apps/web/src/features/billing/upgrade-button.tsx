'use client';

import { Button } from '@/components/ui/button';
import { resolvedPlan, useAccountState } from '@/hooks/billing';
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

  const hasActiveSubscription = !!accountState.subscription?.subscription_id;
  // The RESOLVED plan family, not `subscription.tier_key`. `free` and `none`
  // are the only two keys in the free family, so this is the same set of plans
  // the tier-key compare covered — but it also stops pitching "Upgrade" at an
  // account on an admin trial, whose stored tier_key is still `free` while
  // every server gate treats it as Team.
  const isFreeOrNoPlan = resolvedPlan(accountState).family === 'free';

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
