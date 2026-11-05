'use client';

/**
 * The workspace hooks: every workspace the caller can open, and one workspace.
 *
 * `useWorkspaces` reads the same queries and keys as `useAccounts` and
 * `useProjects(accountId)` (`qk.accounts.list(userId)`,
 * `qk.projects.list(accountId)`), so a host that mixes the old and new hooks
 * still sends one request per list. The state is computed by the pure
 * `workspacesState`, which is what the tests assert: this package has no
 * React test renderer.
 *
 * Not the sandbox file tree: that is `useRuntimeWorkspace`.
 */

import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import {
  buildWorkspaceSummaries,
  compareWorkspacesByRecent,
  getWorkspace,
  listAccounts,
  listProjectsForAccount,
  type KortixAccount,
  type KortixProject,
  type Workspace,
  type WorkspaceSummary,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';
import { accountsQueryOptions, projectsQueryOptions, type UseAccountsOptions } from './use-accounts';

export type UseWorkspacesOptions = UseAccountsOptions;

/** What {@link useWorkspaces} returns. */
export interface UseWorkspacesResult {
  /** Every workspace the caller can open, most recently opened first. */
  workspaces: WorkspaceSummary[];
  /** The caller's accounts, including those with no workspace yet. */
  accounts: KortixAccount[];
  /** The accounts or any account's list is still loading. */
  isLoading: boolean;
  /** The accounts failed, or every account's list failed. */
  isError: boolean;
  /** Accounts whose list failed: their workspaces are unknown, not absent. */
  failedAccountIds: string[];
  /** Refetch every failed list. */
  refetchFailed: () => void;
}

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/** The pure state behind {@link useWorkspaces}. */
export function workspacesState(input: {
  accounts: QueryState<KortixAccount[]>;
  lists: Array<QueryState<KortixProject[]> & { accountId: string }>;
}): Omit<UseWorkspacesResult, 'refetchFailed'> {
  const accounts = input.accounts.data ?? [];
  const workspaces = buildWorkspaceSummaries({ accounts, lists: input.lists }).sort(compareWorkspacesByRecent);
  const failedAccountIds = input.lists.filter((list) => list.isError).map((list) => list.accountId);
  return {
    workspaces,
    accounts,
    isLoading: input.accounts.isLoading || input.lists.some((list) => list.isLoading),
    isError:
      input.accounts.isError ||
      (input.lists.length > 0 && input.lists.every((list) => list.isError)),
    failedAccountIds,
  };
}

/**
 * Every workspace the caller can open. Pass `userId` in any host where the
 * signed-in user can change without a reload (see `useAccounts`).
 */
export function useWorkspaces(options: UseWorkspacesOptions = {}): UseWorkspacesResult {
  const enabled = options.enabled ?? true;
  const accountsQuery = useQuery<KortixAccount[]>({
    ...accountsQueryOptions(options.userId, enabled),
    queryFn: listAccounts,
  });
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const listQueries = useQueries({
    queries: accounts.map((account) => ({
      ...projectsQueryOptions(account.account_id, enabled),
      queryFn: () => listProjectsForAccount(account.account_id),
    })),
  });
  // `listQueries` is a new array every render; this signature is its identity.
  const signature = listQueries.map((q) => `${q.dataUpdatedAt}:${q.isError}:${q.isLoading}`).join('|');
  const state = useMemo(
    () =>
      workspacesState({
        accounts: accountsQuery,
        lists: accounts.map((account, index) => ({
          accountId: account.account_id,
          data: listQueries[index]?.data,
          isLoading: listQueries[index]?.isLoading ?? true,
          isError: listQueries[index]?.isError ?? false,
        })),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, accountsQuery.isLoading, accountsQuery.isError, signature],
  );
  const refetchFailed = useCallback(() => {
    for (const query of listQueries) if (query.isError) void query.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return { ...state, refetchFailed };
}

/** The key + gate + freshness of {@link useWorkspace}, without React. */
export function workspaceQueryOptions(workspaceId: string | null | undefined, enabled = true) {
  return {
    queryKey: qk.project.workspace(workspaceId ?? ''),
    enabled: enabled && Boolean(workspaceId),
    ...contract('config'),
  };
}

export interface UseWorkspaceOptions {
  enabled?: boolean;
}

/** One workspace with the caller's role and its settings (`getWorkspace`). */
export function useWorkspace(workspaceId: string | null | undefined, options: UseWorkspaceOptions = {}) {
  return useQuery<Workspace>({
    ...workspaceQueryOptions(workspaceId, options.enabled ?? true),
    queryFn: () => getWorkspace(workspaceId as string),
  });
}
