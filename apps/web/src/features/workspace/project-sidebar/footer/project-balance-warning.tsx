'use client';

import {
  SidebarAlertRow,
  type SidebarAlertTone,
} from '@/features/workspace/project-sidebar/footer/sidebar-alert';
import { useAccountState } from '@/hooks/billing';
import { billingDialogArgs, resolveBillingState } from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { WarningIcon as AlertTriangle, CreditCardIcon as CreditCard } from '@phosphor-icons/react';
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
      openUpgradeDialog(
        billingDialogArgs(resolveBillingState(accountState), accountState, accountId),
      ),
    [openUpgradeDialog, accountId, accountState],
  );

  if (!isBillingEnabled() || !accountState || !canTopUp) {
    return { severity: null as 'empty' | 'low' | null, handleClick };
  }

  const severity: 'empty' | 'low' | null =
    balance <= 0 ? 'empty' : balance < LOW_BALANCE_USD ? 'low' : null;

  return { severity, handleClick };
}

/**
 * This row used to be the loudest thing in the footer: a tinted fill *and* a
 * coloured border at `h-9`, next to two `h-8` alerts that were transparent. It
 * now wears the shared footer dialect, so an empty wallet reads as urgent
 * through its colour rather than through extra chrome — and the row lines up
 * with every other row in the sidebar.
 */
export function SidebarBalanceWarning({ accountId }: { accountId?: string }) {
  const { severity, handleClick } = useBalanceWarning(accountId);
  if (!severity) return null;

  const isEmpty = severity === 'empty';
  const tone: SidebarAlertTone = isEmpty ? 'critical' : 'warning';

  return (
    <SidebarAlertRow
      tone={tone}
      icon={isEmpty ? <AlertTriangle className="size-4" /> : <CreditCard className="size-4" />}
      label={isEmpty ? 'Out of credits' : 'Low balance'}
      trailing="Top up"
      onClick={handleClick}
    />
  );
}
