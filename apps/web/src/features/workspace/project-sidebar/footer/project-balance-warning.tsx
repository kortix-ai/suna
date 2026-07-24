'use client';

import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { AlertTriangle, CreditCard } from 'lucide-react';
import { useCallback } from 'react';

/** Warn once the wallet drops below this (dollars). Negative/zero is always a
 *  hard "out of credits"; between $0 and here is a softer "low balance" nudge. */
const LOW_BALANCE_USD = 5;

function useBalanceWarning(accountId?: string) {
  const { data: accountState } = useAccountState({ accountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const balance = accountState?.credits?.total ?? 0;
  const isPerSeat = accountState?.billing_model === 'per_seat';
  // Only accounts that can actually top up (Team / paid) get this warning —
  // a free account can't buy credits, so it keeps the "Upgrade Plan" button.
  const canTopUp = (accountState?.tier?.can_purchase_credits ?? false) || isPerSeat;

  const handleClick = useCallback(
    () =>
      openUpgradeDialog({
        reason: 'insufficient_credits',
        accountId,
        billingModel: accountState?.billing_model,
        hasSubscription: Boolean(accountState?.subscription?.subscription_id),
        balance,
      }),
    [openUpgradeDialog, accountId, accountState, balance],
  );

  if (!isBillingEnabled() || !accountState || !canTopUp) {
    return { severity: null as 'empty' | 'low' | null, handleClick };
  }

  const severity: 'empty' | 'low' | null =
    balance <= 0 ? 'empty' : balance < LOW_BALANCE_USD ? 'low' : null;

  return { severity, handleClick };
}

export function SidebarBalanceWarning({ accountId }: { accountId?: string }) {
  const { severity, handleClick } = useBalanceWarning(accountId);
  if (!severity) return null;

  const isEmpty = severity === 'empty';

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        size="md"
        onClick={handleClick}
        className={cn(
          'flex w-full items-center gap-2 border font-medium [&_svg]:size-3.5!',
          isEmpty
            ? 'text-destructive border-destructive/30 bg-destructive/[0.06] hover:bg-destructive/10 hover:text-destructive'
            : 'text-kortix-orange border-kortix-orange/30 bg-kortix-orange/[0.06] hover:bg-kortix-orange/10 hover:text-kortix-orange',
        )}
      >
        {isEmpty ? <AlertTriangle /> : <CreditCard />}
        <span className="flex-1 text-left">{isEmpty ? 'Out of credits' : 'Low balance'}</span>
        <span className="text-xs opacity-70">Top up</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
