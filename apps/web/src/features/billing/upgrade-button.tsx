'use client';

import { Button } from '@/components/ui/button';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { ArrowUpRight } from 'lucide-react';

interface UpgradeButtonProps {
  accountId?: string;
  className?: string;
  variant?: 'header' | 'sidebar';
}

export function UpgradeButton({ accountId, className, variant = 'header' }: UpgradeButtonProps) {
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

  if (variant === 'sidebar') {
    return (
      <Button
        type="button"
        size="sm"
        className={cn(
          'w-full justify-center group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0',
          className,
        )}
        onClick={handleClick}
      >
        <ArrowUpRight className="size-4" />
        <span className="group-data-[collapsible=icon]:hidden">Upgrade</span>
      </Button>
    );
  }

  return (
    <Button type="button" className={className} onClick={handleClick}>
      <ArrowUpRight className="size-4" />
      Upgrade
    </Button>
  );
}
