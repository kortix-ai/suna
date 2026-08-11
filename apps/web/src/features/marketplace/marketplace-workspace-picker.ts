'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { listWorkspacesForAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

/**
 * Shared "pick a workspace to add this item to" query + auto-select state, used
 * by the one unified `AddToWorkspaceModal` (which also offers a "＋ New
 * workspace" sentinel alongside whatever this returns). Lists the caller's
 * workspaces under one query key and auto-picks a sensible default the first
 * time the list loads.
 *
 * Fetches with no account_id, so this is the ONE real reader of
 * `qk.workspaces.list()` — the API resolves that to the caller's primary
 * (earliest-joined) account. Every mutation that invalidates the shared
 * `['kx', 'workspaces']` prefix reaches this entry too, keeping it out of the
 * stale trap a private key would fall into.
 */
export function useWorkspacePicker({
  open,
  enabled = true,
  preferredWorkspaceId,
}: {
  /** Only fetches while the owning modal is open. */
  open: boolean;
  /** Set false to skip the query entirely (e.g. a fixed-workspace modal that
   *  never shows a picker). */
  enabled?: boolean;
  /** Auto-selected once the list loads, if it's one of the account's
   *  workspaces — e.g. the workspace you're already customizing, so re-merging
   *  into it is the default instead of an arbitrary first item. Falls back
   *  to `workspaces[0]` when unset or not in the list. */
  preferredWorkspaceId?: string;
}) {
  const { user } = useAuth();
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState('');

  const workspacesQuery = useQuery({
    queryKey: qk.workspaces.list(),
    queryFn: () => listWorkspacesForAccount(),
    enabled: !!user && open && enabled,
    ...contract('inventory'),
  });
  const workspaces = workspacesQuery.data ?? [];

  useEffect(() => {
    if (!open || pickedWorkspaceId || workspaces.length === 0) return;
    const preferred =
      preferredWorkspaceId &&
      workspaces.some((workspace) => workspace.workspace_id === preferredWorkspaceId)
        ? preferredWorkspaceId
        : workspaces[0].workspace_id;
    setPickedWorkspaceId(preferred);
  }, [open, workspaces, pickedWorkspaceId, preferredWorkspaceId]);

  return { workspaces, workspacesQuery, pickedWorkspaceId, setPickedWorkspaceId };
}
