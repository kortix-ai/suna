'use client';

import { useQueries } from '@tanstack/react-query';
import { probeEffectivePermission, type KortixAccount } from '@kortix/sdk';
import { useAuth } from '@/features/providers/auth-provider';
import { permissionProbeKey } from '@kortix/sdk/react';
import { canCreateInAccount, filterCreatableAccounts } from './new-workspace-form';

/**
 * Project creation is an account-scoped IAM leaf, not an account-role label:
 * the settled probe verdict decides, and `canCreateInAccount` falls back to
 * the role only while the probe has not answered yet (KRTX-1700 — otherwise a
 * fresh owner's first /projects render says "ask an admin").
 */
export function useCreatableAccounts(accounts: KortixAccount[]): KortixAccount[] {
  const { user } = useAuth();
  const verdicts = useQueries({
    queries: accounts.map((account) => ({
      queryKey: permissionProbeKey(account.account_id, user?.id, 'project.create'),
      queryFn: () => probeEffectivePermission(account.account_id, user!.id, { action: 'project.create' }),
      enabled: !!user?.id,
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
