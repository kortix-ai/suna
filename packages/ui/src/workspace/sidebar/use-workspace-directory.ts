'use client';

import { listProjectsForAccount, type KortixAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAccountsList } from '../../internal/hooks/account/use-accounts-list';
import {
  buildWorkspaceRows,
  failedAccountIds,
  reusableEmptyAccount,
  type ProjectListResult,
  type WorkspaceRow,
} from '../project-selector/project-selector-model';

export interface WorkspaceDirectory {
  accounts: KortixAccount[];
  /** Every workspace the caller can open, flat, most recently opened first. */
  workspaces: WorkspaceRow[];
  /** Accounts and every project list are known. */
  loading: boolean;
  /** Accounts whose project list failed: their workspaces are unknown, not absent. */
  failedAccountIds: string[];
  /** The owned empty account "Create workspace" fills, or null. */
  reusableAccount: KortixAccount | null;
  retryFailed: () => void;
}

/**
 * Every workspace the caller belongs to — the switcher's and the palette's one
 * list (`buildWorkspaceRows`).
 *
 * `GET /projects` without `account_id` scopes to ONE default account
 * server-side, so the lists fan out per account. The query keys are the
 * chooser's (`qk.projects.list(accountId)`), so the chooser, the sidebar and
 * the palette share one request per account.
 */
export function useWorkspaceDirectory(): WorkspaceDirectory {
  const accountsQuery = useAccountsList();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const listQueries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: qk.projects.list(account.account_id),
      queryFn: () => listProjectsForAccount(account.account_id),
      ...contract('inventory'),
    })),
  });

  // Without `accountsQuery.isLoading` this is `false` while accounts are in
  // flight (`[].some(...)` is `false`), and the menu would paint "no
  // workspaces" before it asked how many accounts exist.
  const loading = accountsQuery.isLoading || listQueries.some((query) => query.isLoading);
  const signature = listQueries.map((query) => `${query.dataUpdatedAt}:${query.isError}`).join('|');
  const lists: ProjectListResult[] = useMemo(
    () =>
      accounts.map((account, index) => ({
        accountId: account.account_id,
        data: listQueries[index]?.data,
        isError: listQueries[index]?.isError ?? false,
      })),
    // `listQueries` is a new array every render; the signature is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, signature],
  );

  const workspaces = useMemo(() => buildWorkspaceRows({ accounts, lists }), [accounts, lists]);
  const failed = useMemo(() => failedAccountIds(lists), [lists]);
  const reusableAccount = useMemo(() => reusableEmptyAccount({ accounts, lists }), [accounts, lists]);

  return {
    accounts,
    workspaces,
    loading,
    failedAccountIds: failed,
    reusableAccount,
    retryFailed: () => {
      for (const query of listQueries) if (query.isError) void query.refetch();
    },
  };
}
