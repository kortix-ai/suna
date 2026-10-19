import { newWorkspacePathForAccount } from '@/features/workspace/new/account-param';
import type { KortixAccount } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** Seed the reader's exact slot before selecting and opening the empty account. */
export function accountCreated(
  account: KortixAccount,
  queryClient: QueryClient,
  accountsQueryKey: QueryKey,
  select: (accountId: string) => void,
  navigate: (path: string) => void,
) {
  queryClient.setQueryData<KortixAccount[]>(accountsQueryKey, (accounts) => {
    const current = accounts ?? [];
    return current.some((item) => item.account_id === account.account_id)
      ? current.map((item) => (item.account_id === account.account_id ? account : item))
      : [account, ...current];
  });
  void queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
  select(account.account_id);
  void queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
  navigate(newWorkspacePathForAccount(account.account_id));
}
