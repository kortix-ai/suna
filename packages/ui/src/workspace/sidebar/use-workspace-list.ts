'use client';

import { listWorkspaces, restoreWorkspace, setupWorkspace, type WorkspaceSummary } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAccountsList } from '../../internal/hooks/account/use-accounts-list';
import { useUiViewerId } from '../../providers/ui-provider';
import {
  githubSourceAccount,
  reusableEmptyAccountFromRows,
  workspaceRowsFromSummaries,
  type WorkspaceRow,
} from '../project-selector/project-selector-model';

/**
 * Every workspace of the caller in every state, from ONE request:
 * `GET /v1/workspaces` (`listWorkspaces({ includeInactive: true })`, design.md
 * C5). The chooser, the `/workspaces/start` door and the sidebar switcher read
 * this list. A `setup_required` row offers Set up, a `deleting` row (owners
 * only) offers Restore; neither opens until then.
 *
 * Its own key under `qk.projects.scope()`: `useWorkspaces` keys the
 * active-only list, and two shapes under one key would serve each other's
 * rows. Every create, delete and join invalidates the scope.
 */
export function workspaceListQueryKey(userId: string | null | undefined) {
  return [...qk.projects.workspaces(userId), 'every-state'] as const;
}

export interface WorkspaceList {
  /** Every workspace, most recently opened first. */
  rows: WorkspaceRow[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
  /** @deprecated No create fills an empty account; read `githubSourceAccount`. */
  reusableAccount: ReturnType<typeof reusableEmptyAccountFromRows>;
  /** The account whose GitHub connection a GitHub-source create uses (`githubSourceAccount`), or null. */
  githubSourceAccount: ReturnType<typeof githubSourceAccount>;
  accountsQuery: ReturnType<typeof useAccountsList>;
}

export function useWorkspaceList(options: { retry?: number } = {}): WorkspaceList {
  const viewerId = useUiViewerId();
  const accountsQuery = useAccountsList(options.retry === undefined ? undefined : { retry: options.retry });
  const listQuery = useQuery<WorkspaceSummary[]>({
    queryKey: workspaceListQueryKey(viewerId),
    queryFn: () => listWorkspaces({ includeInactive: true }),
    retry: options.retry,
    ...contract('inventory'),
  });
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const rows = useMemo(
    () => workspaceRowsFromSummaries({ summaries: listQuery.data ?? [], accounts }),
    [listQuery.data, accounts],
  );
  const reusableAccount = useMemo(
    () => reusableEmptyAccountFromRows({ accounts, rows: listQuery.data ? rows : undefined }),
    [accounts, rows, listQuery.data],
  );
  const githubSource = useMemo(
    () => githubSourceAccount({ accounts, rows: listQuery.data ? rows : undefined }),
    [accounts, rows, listQuery.data],
  );
  return {
    rows,
    loading: listQuery.isLoading,
    failed: listQuery.isError,
    retry: () => {
      if (listQuery.isError) void listQuery.refetch();
      if (accountsQuery.isError) void accountsQuery.refetch();
    },
    reusableAccount,
    githubSourceAccount: githubSource,
    accountsQuery,
  };
}

/**
 * Set up a `setup_required` workspace (it pays but has no repository yet) or
 * restore a `deleting` one. Both answer the workspace, which then opens.
 */
export function useWorkspaceStateActions(onReady: (workspaceId: string) => void) {
  const queryClient = useQueryClient();
  const settle = (workspaceId: string) => {
    void queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
    void queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
    onReady(workspaceId);
  };
  const setup = useMutation({
    mutationFn: (workspaceId: string) => setupWorkspace(workspaceId),
    onSuccess: (_workspace, workspaceId) => settle(workspaceId),
  });
  const restore = useMutation({
    mutationFn: (workspaceId: string) => restoreWorkspace(workspaceId),
    onSuccess: (_workspace, workspaceId) => settle(workspaceId),
  });
  return { setup, restore };
}
