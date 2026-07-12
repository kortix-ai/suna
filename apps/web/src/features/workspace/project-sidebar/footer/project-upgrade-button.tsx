'use client';

import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { ArrowUpRight } from 'lucide-react';
import { useCallback } from 'react';

interface SidebarUpgradeButtonProps {
  accountId?: string;
  className?: string;
}

const upgradeButtonClassName =
  'text-background border-border  bg-foreground dark:bg-foreground dark:hover:bg-foreground/80 hover:bg-foreground/90 flex items-center justify-center border-[1.2px] text-center hover:text-background';

function useSidebarUpgrade(accountId?: string) {
  const { data: accountState } = useAccountState({ accountId });
  const openUpgradeDialog = useUpgradeDialogStore((state) => state.openUpgradeDialog);

  const handleClick = useCallback(
    () =>
      openUpgradeDialog({
        reason: 'subscription_required',
        accountId,
      }),
    [openUpgradeDialog, accountId],
  );

  if (!isBillingEnabled() || !accountState) {
    return { show: false as const, handleClick };
  }

  const tierKey = accountStateSelectors.tierKey(accountState).toLowerCase();
  const hasActiveSubscription = !!accountState.subscription?.subscription_id;
  const isFreeOrNoPlan = tierKey === 'free' || tierKey === 'none';
  const show = isFreeOrNoPlan && !hasActiveSubscription;

  return { show, handleClick };
}

export function SidebarUpgradeButton({ accountId, className }: SidebarUpgradeButtonProps) {
  const { show, handleClick } = useSidebarUpgrade(accountId);

  if (!show) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        size="md"
        className={cn(
          'relative flex w-full items-center justify-center',
          upgradeButtonClassName,
          className,
        )}
        onClick={handleClick}
      >
        Upgrade Plan
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function SidebarUpgradeRailItem({ accountId }: { accountId?: string }) {
  const { show, handleClick } = useSidebarUpgrade(accountId);

  if (!show) return null;

  return (
    <Hint label="Upgrade">
      <SidebarMenuButton
        type="button"
        aria-label="Upgrade"
        onClick={handleClick}
        className={cn(upgradeButtonClassName, '[&_svg]:text-background size-8 [&_svg]:size-4!')}
      >
        <ArrowUpRight />
      </SidebarMenuButton>
    </Hint>
  );
}
