'use client';

import type { KortixAccount } from '@kortix/sdk';
import { useMemo } from 'react';

import { isOpenableRow, type WorkspaceRow } from '../project-selector/project-selector-model';
import { useWorkspaceList } from './use-workspace-list';

export interface WorkspaceDirectory {
  accounts: KortixAccount[];
  /** Every workspace of the caller in every state, most recently opened first. */
  workspaces: WorkspaceRow[];
  /** The workspaces that open now (`state: 'active'`). */
  openable: WorkspaceRow[];
  /** The list is not known yet. */
  loading: boolean;
  /** Non-empty when the list failed: its workspaces are unknown, not absent. */
  failedAccountIds: string[];
  /** The owned empty account a GitHub-source create fills, or null. */
  reusableAccount: KortixAccount | null;
  retryFailed: () => void;
}

/**
 * Every workspace the caller belongs to — the switcher's and the palette's one
 * list, from one request (`GET /v1/workspaces`, `useWorkspaceList`). The
 * chooser reads the same query, so opening one after the other costs nothing.
 */
export function useWorkspaceDirectory(): WorkspaceDirectory {
  const list = useWorkspaceList();
  const accounts = useMemo(() => list.accountsQuery.data ?? [], [list.accountsQuery.data]);
  const openable = useMemo(() => list.rows.filter(isOpenableRow), [list.rows]);
  return {
    accounts,
    workspaces: list.rows,
    openable,
    loading: list.loading || list.accountsQuery.isLoading,
    failedAccountIds: list.failed ? ['workspaces'] : [],
    reusableAccount: list.reusableAccount,
    retryFailed: list.retry,
  };
}
