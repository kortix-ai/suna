'use client';

import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { resolvedPlan, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useTranslations } from '@/i18n/use-translations';
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

  if (!isBillingEnabled() || !accountState) {
    return { show: false as const, trial: null, handleClick };
  }

  // A trial is always visible, with the upgrade one click away: the account
  // must never learn it was on a trial when the trial ends.
  const trial = accountState.trial ?? null;
  const hasActiveSubscription = !!accountState.subscription?.subscription_id;
  // The RESOLVED plan family (free = the keys `free` and `none`), so an admin
  // trial reads as paid here, exactly as the server's gates read it.
  const isFreeOrNoPlan = resolvedPlan(accountState).family === 'free';
  const show = !!trial || (isFreeOrNoPlan && !hasActiveSubscription);

  return { show, trial, handleClick };
}

export function SidebarUpgradeButton({ accountId, className }: SidebarUpgradeButtonProps) {
  const t = useTranslations('sidebar');
  const { show, trial, handleClick } = useSidebarUpgrade(accountId);

  if (!show) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        variant="primary"
        className={cn(className)}
        onClick={handleClick}
      >
        {trial
          ? t('trialBadge', {
              plan: trial.plan === 'enterprise' ? t('trialPlanEnterprise') : t('trialPlanCredits'),
              days: trial.days_left,
            })
          : t('upgradePlan')}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
