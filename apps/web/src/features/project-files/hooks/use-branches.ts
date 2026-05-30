'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchBranches } from '../api/branches';
import { useProjectContext } from '../context';
import type { ProjectBranchesResponse } from '@/lib/projects-client';

export const branchKeys = {
  all: ['project-files', 'branches'] as const,
  list: (projectId: string) => ['project-files', 'branches', projectId] as const,
};

/**
 * Versions (branches) for a project. Reads the id from {@link useProjectContext}
 * by default; pass `projectId` to use it outside the provider (e.g. the
 * sessions page). Empty list while the id is missing or the call is in flight.
 */
export function useBranches(options?: { enabled?: boolean; projectId?: string }) {
  const ctx = useProjectContext();
  const projectId = options?.projectId ?? ctx?.projectId ?? '';

  return useQuery<ProjectBranchesResponse>({
    queryKey: branchKeys.list(projectId),
    queryFn: () => fetchBranches(projectId),
    enabled: Boolean(projectId) && options?.enabled !== false,
    staleTime: 30_000,
  });
}
