'use client';

import {
  SidebarAlertRow,
  type SidebarAlertTone,
} from '@/features/workspace/project-sidebar/footer/sidebar-alert';
import { useAccountState } from '@/hooks/billing';
import {
  billingDialogArgs,
  resolveBillingState,
  walletAlertCopy,
  walletSeverity,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { WarningIcon as AlertTriangle, CreditCardIcon as CreditCard } from '@phosphor-icons/react';
import { useCallback } from 'react';

function useBalanceWarning(accountId?: string) {
  const { data: accountState } = useAccountState({ accountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

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
    return { severity: null as ReturnType<typeof walletSeverity>, handleClick };
  }

  // Severity comes from `walletSeverity`, never from the raw balance. This
  // component used to compute `balance <= 0 ? 'empty' : balance < 5 ? 'low'`
  // itself, which is how a fully-running account got a permanent red
  // "Out of credits" row while the project page beside it started sessions
  // without complaint.
  return { severity: walletSeverity(accountState), handleClick };
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

  const isBlocked = severity === 'blocked';
  const tone: SidebarAlertTone = isBlocked ? 'critical' : 'warning';
  const copy = walletAlertCopy(severity);

  return (
    <SidebarAlertRow
      tone={tone}
      icon={isBlocked ? <AlertTriangle className="size-4" /> : <CreditCard className="size-4" />}
      label={copy.label}
      trailing={copy.action}
      onClick={handleClick}
    />
  );
}
