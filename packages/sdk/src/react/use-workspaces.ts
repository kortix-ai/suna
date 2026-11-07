'use client';

/**
 * The workspace hooks: every workspace the caller can open, and one workspace.
 *
 * `useWorkspaces` reads `listWorkspaces()`: one `GET /v1/workspaces` for every
 * workspace across accounts (`qk.projects.workspaces(userId)`), plus the
 * caller's accounts (`qk.accounts.list(userId)`, shared with `useAccounts`).
 * `workspacesState` is the pure state of the older per-account read, kept
 * for hosts that compose `useAccounts` and `useProjects` themselves. This
 * package has no React test renderer: the tests assert the pure parts.
 *
 * Not the sandbox file tree: that is `useRuntimeWorkspace`.
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import {
  buildWorkspaceSummaries,
  compareWorkspacesByRecent,
  getWorkspace,
  listAccounts,
  listWorkspaces,
  type KortixAccount,
  type KortixProject,
  type Workspace,
  type WorkspaceSummary,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';
import { accountsQueryOptions, type UseAccountsOptions } from './use-accounts';

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
  /**
   * Accounts whose list failed: their workspaces are unknown, not absent.
   * Always empty for `useWorkspaces` (one list for every account).
   */
  failedAccountIds: string[];
  /** Refetch a failed list. */
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

/** The key + gate + freshness of {@link useWorkspaces}' list, without React. */
export function workspacesQueryOptions(userId?: string | null, enabled = true) {
  return {
    queryKey: qk.projects.workspaces(userId),
    enabled,
    ...contract('inventory'),
  };
}

/**
 * Every workspace the caller can open, across accounts, in one request
 * (`listWorkspaces`). Pass `userId` in any host where the signed-in user can
 * change without a reload (see `useAccounts`).
 */
export function useWorkspaces(options: UseWorkspacesOptions = {}): UseWorkspacesResult {
  const enabled = options.enabled ?? true;
  const accountsQuery = useQuery<KortixAccount[]>({
    ...accountsQueryOptions(options.userId, enabled),
    queryFn: listAccounts,
  });
  const workspacesQuery = useQuery<WorkspaceSummary[]>({
    ...workspacesQueryOptions(options.userId, enabled),
    queryFn: () => listWorkspaces(),
  });
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const { refetch, isError } = workspacesQuery;
  const refetchFailed = useCallback(() => {
    if (isError) void refetch();
  }, [isError, refetch]);
  return {
    workspaces,
    accounts,
    isLoading: workspacesQuery.isLoading,
    isError: workspacesQuery.isError,
    failedAccountIds: [],
    refetchFailed,
  };
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
