'use client';

import { listProjectsForAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { useMyInvites } from '@/hooks/account/use-my-invites';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import { buildAccountSections, type AccountSection } from './project-selector-model';

/**
 * The account whose project list may be read BEFORE `GET /accounts` answers.
 *
 * The lists fan out per account, so they used to wait for the account list:
 * staging HAR, `/v1/accounts` (1.58 s) then `/v1/projects?account_id=` (1.40 s)
 * in series. The account the user last worked in is already in localStorage
 * (`kortix.currentAccount`), so its list starts in parallel.
 *
 * Validated after the fact, not trusted: the speculative read only fills the
 * `qk.projects.list(id)` entry, and a section renders only for an account the
 * account list returns. A stale or foreign id costs one request the API
 * refuses; it never renders. Stops the moment the account list is known.
 */
export function speculativeProjectListAccountId(input: {
  userId: string | null | undefined;
  cachedAccountId: string | null | undefined;
  accountsLoaded: boolean;
}): string | null {
  if (!input.userId || input.accountsLoaded) return null;
  return input.cachedAccountId || null;
}

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

  const { user } = useAuth();
  const cachedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);
  const speculativeAccountId = speculativeProjectListAccountId({
    userId: user?.id,
    cachedAccountId,
    accountsLoaded: accountsQuery.data !== undefined,
  });
  // Same key, fetcher and contract as the per-account list below, so the list
  // that renders reuses this read (in flight or cached) instead of issuing it.
  useQuery({
    queryKey: qk.projects.list(speculativeAccountId ?? ''),
    queryFn: () => listProjectsForAccount(speculativeAccountId as string),
    enabled: speculativeAccountId !== null,
    ...contract('inventory'),
  });

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
