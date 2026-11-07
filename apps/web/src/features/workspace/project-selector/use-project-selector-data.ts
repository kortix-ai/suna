'use client';

import { useMyInvites } from '@kortix/ui/internal/hooks/account/use-my-invites';
import { isOpenableRow } from '@kortix/ui/workspace/project-selector/project-selector-model';
import { useWorkspaceList } from '@kortix/ui/workspace/sidebar/use-workspace-list';

/**
 * Every read the chooser and the `/workspaces/start` door need: every
 * workspace of the caller in every state (`GET /v1/workspaces`, one request,
 * `useWorkspaceList`) and the caller's pending invites. The switcher reads the
 * same query, so opening the chooser from the switcher costs no request.
 */
export function useProjectSelectorData() {
  // `retry: 3`: the door decides where to go FROM this list, so one transient
  // failure must not strand the user.
  const list = useWorkspaceList({ retry: 3 });
  const invitesQuery = useMyInvites();

  return {
    accountsQuery: list.accountsQuery,
    invitesQuery,
    invites: invitesQuery.data ?? [],
    workspaces: list.rows,
    /** The workspaces that open now (`state: 'active'`). */
    openable: list.rows.filter(isOpenableRow),
    /** Kept for the view's partial-failure line: one list, so never partial. */
    failedAccountIds: [] as string[],
    /** The list is known. Invites load separately. */
    listsLoading: list.loading,
    /** The list failed — nothing trustworthy to show. */
    allListsFailed: list.failed,
    retryAll: list.retry,
  };
}
