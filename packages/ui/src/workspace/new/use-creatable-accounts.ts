'use client';

import { type KortixAccount, probeEffectivePermission } from '@kortix/sdk';
import { permissionProbeKey } from '@kortix/sdk/react';
import { useQueries } from '@tanstack/react-query';
import { useUiViewerId } from '../../providers/ui-provider';
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
      queryFn: () => {
        if (!viewerId) throw new Error('viewer id missing for the project.create probe');
        return probeEffectivePermission(account.account_id, viewerId, { action: 'project.create' });
      },
      enabled: !!viewerId,
      staleTime: 5 * 60_000,
    })),
  });
  return filterCreatableAccounts(
    accounts,
    Object.fromEntries(
      accounts.map((account, i) => [
        account.account_id,
        // A settled error is not a grant: fail closed (KRTX-4005). Only a
        // probe that has NOT answered yet keeps the role fallback (KRTX-1700).
        verdicts[i]?.isError ? false : canCreateInAccount(account, verdicts[i]?.data?.allowed),
      ]),
    ),
  );
}
