'use client';

import { canManageBilling, platformConfig } from '@kortix/sdk';

import { SidebarMenuButton, SidebarMenuItem } from '../../../primitives/sidebar';
import { resolvedPlan, useAccountState } from '../../../internal/billing';
import { accountHasLiveSubscription } from '../../../internal/lib/billing/billing-gate-state';
import { cn } from '../../../internal/lib/utils';
import { useUpgradeDialogStore } from '../../../internal/stores/upgrade-dialog-store';
import { useTranslations } from '../../../i18n';
import { useCallback } from 'react';

interface SidebarUpgradeButtonProps {
  accountId?: string;
  className?: string;
}

/**
 * The one solid button in the footer, and deliberately the only one.
 *
 * Everything else down here is an alert — tinted text on the sidebar's own
 * background (see `sidebar-alert.tsx`). This is an offer, so it inverts: a
 * filled row at `h-9`, one step taller than the `h-8` alerts above it. That
 * single difference in weight is the whole hierarchy, which is why the border
 * is gone — a rim around a solid black button adds chrome and no information.
 *
 * `active:` is spelled out because the sidebar recipe's own
 * `active:bg-sidebar-accent` would flash this button light grey on press.
 */

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

  if (!platformConfig().billingEnabled || !accountState) {
    return { show: false as const, handleClick };
  }

  // The RESOLVED plan family (free = the keys `free` and `none`), exactly as
  // the server's gates read it. A live subscription already pays. A caller
  // without `billing.write` cannot subscribe, so the offer is not theirs.
  const isFreeOrNoPlan = resolvedPlan(accountState).family === 'free';
  const show =
    isFreeOrNoPlan && !accountHasLiveSubscription(accountState) && canManageBilling(accountState);

  return { show, handleClick };
}

export function SidebarUpgradeButton({ accountId, className }: SidebarUpgradeButtonProps) {
  const t = useTranslations('sidebar');
  const { show, handleClick } = useSidebarUpgrade(accountId);

  if (!show) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton type="button" variant="primary" className={cn(className)} onClick={handleClick}>
        {t('upgradePlan')}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
