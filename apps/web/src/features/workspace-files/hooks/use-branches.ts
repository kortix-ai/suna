'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchBranches } from '../api/branches';
import { useWorkspaceContext } from '../context';
import type { WorkspaceBranchesResponse } from '@kortix/sdk';

export const branchKeys = {
  all: ['workspace-files', 'branches'] as const,
  list: (workspaceId: string) => ['workspace-files', 'branches', workspaceId] as const,
};

/**
 * Versions (branches) for a workspace. Reads the id from {@link useWorkspaceContext}
 * by default; pass `workspaceId` to use it outside the provider (e.g. the
 * sessions page). Empty list while the id is missing or the call is in flight.
 */
export function useBranches(options?: { enabled?: boolean; workspaceId?: string }) {
  const ctx = useWorkspaceContext();
  const workspaceId = options?.workspaceId ?? ctx?.workspaceId ?? '';

  return useQuery<WorkspaceBranchesResponse>({
    queryKey: branchKeys.list(workspaceId),
    queryFn: () => fetchBranches(workspaceId),
    enabled: Boolean(workspaceId) && options?.enabled !== false,
    staleTime: 30_000,
  });
}
