'use client';

import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { resolvedPlan, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
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
    return { show: false as const, handleClick };
  }

  const hasActiveSubscription = !!accountState.subscription?.subscription_id;
  // The RESOLVED plan family (free = the keys `free` and `none`), so an admin
  // trial and a self-healed per-seat team both read as Team here, exactly as
  // the server's gates read them.
  const isFreeOrNoPlan = resolvedPlan(accountState).family === 'free';
  // Kept on top of that: a per-seat account with no live Stripe subscription
  // does NOT self-heal, so the resolver still reports it free. It is never "on
  // Free" from the customer's side — it gets the balance/top-up warning instead
  // of an "Upgrade plan" pitch.
  const isPerSeat = accountState.billing_model === 'per_seat';
  const show = isFreeOrNoPlan && !hasActiveSubscription && !isPerSeat;

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
        variant="primary"
        className={cn(className)}
        onClick={handleClick}
      >
        Upgrade plan
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
