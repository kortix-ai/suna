'use client';

import { useQueries } from '@tanstack/react-query';
import { probeEffectivePermission, type KortixAccount } from '@kortix/sdk';
import { useUiViewerId } from '../../providers/ui-provider';
import { permissionProbeKey } from '@kortix/sdk/react';
import { canCreateInAccount, filterCreatableAccounts } from './new-workspace-form';

/**
 * Project creation is an account-scoped IAM leaf, not an account-role label:
 * the settled probe verdict decides, and `canCreateInAccount` falls back to
 * the role only while the probe has not answered yet (KRTX-1700 — otherwise a
 * fresh owner's first /projects render says "ask an admin").
 */
export function useCreatableAccounts(accounts: KortixAccount[]): KortixAccount[] {
  const viewerId = useUiViewerId();
  const verdicts = useQueries({
    queries: accounts.map((account) => ({
      queryKey: permissionProbeKey(account.account_id, viewerId, 'project.create'),
      queryFn: () => probeEffectivePermission(account.account_id, viewerId!, { action: 'project.create' }),
      enabled: !!viewerId,
      staleTime: 5 * 60_000,
    })),
  });
  return filterCreatableAccounts(
    accounts,
    Object.fromEntries(
      accounts.map((account, i) => [account.account_id, canCreateInAccount(account, verdicts[i]?.data?.allowed)]),
    ),
  );
}
