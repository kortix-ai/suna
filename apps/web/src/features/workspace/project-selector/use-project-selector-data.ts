'use client';

import { listProjectsForAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { useMyInvites } from '@/hooks/account/use-my-invites';

import { buildAccountSections, type AccountSection } from './project-selector-model';

/**
 * Every read the selector and the `/projects/start` door need: the accounts,
 * one project list per account, and the caller's pending invites.
 *
 * `GET /projects` without `account_id` scopes to ONE default account
 * server-side, so the lists fan out per account. The query keys are the
 * switcher's (`qk.projects.list(accountId)`), so opening the selector from the
 * switcher, or the switcher after the selector, costs no second request.
 */
export function useProjectSelectorData() {
  // `retry: 3`: the door decides where to go FROM this list, so one transient
  // failure must not strand the user.
  const accountsQuery = useAccountsList({ retry: 3 });
  const invitesQuery = useMyInvites();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);

  const listQueries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: qk.projects.list(account.account_id),
      queryFn: () => listProjectsForAccount(account.account_id),
      ...contract('inventory'),
    })),
  });

  const listsLoading = accountsQuery.isLoading || listQueries.some((query) => query.isLoading);
  const listSignature = listQueries.map((query) => `${query.dataUpdatedAt}:${query.isError}`).join('|');

  const sections: AccountSection[] = useMemo(
    () =>
      buildAccountSections({
        accounts,
        lists: accounts.map((account, index) => ({
          accountId: account.account_id,
          data: listQueries[index]?.data,
          isError: listQueries[index]?.isError ?? false,
        })),
      }),
    // `listQueries` is a new array every render; the signature is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, listSignature],
  );

  const retryAccount = (accountId: string) => {
    const index = accounts.findIndex((account) => account.account_id === accountId);
    if (index >= 0) void listQueries[index]?.refetch();
  };

  return {
    accountsQuery,
    invitesQuery,
    invites: invitesQuery.data ?? [],
    sections,
    /** Accounts and every project list are known. Invites load separately. */
    listsLoading,
    /** Every project list failed — nothing trustworthy to show. */
    allListsFailed: listQueries.length > 0 && listQueries.every((query) => query.isError),
    retryAccount,
    retryAll: () => {
      if (accountsQuery.isError) void accountsQuery.refetch();
      for (const query of listQueries) if (query.isError) void query.refetch();
    },
  };
}
