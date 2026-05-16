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
 * Versions (branches) for the current project. Empty list while the project
 * context is missing or the API call is in flight.
 */
export function useBranches(options?: { enabled?: boolean }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';

  return useQuery<ProjectBranchesResponse>({
    queryKey: branchKeys.list(projectId),
    queryFn: () => fetchBranches(projectId),
    enabled: Boolean(projectId) && options?.enabled !== false,
    staleTime: 30_000,
  });
}
