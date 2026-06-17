'use client';

/**
 * Marketplace feature gate. The Marketplace now lives INSIDE Customize (a rail
 * section next to Skills / Agents / Commands), not in the project sidebar — so
 * this file is just the shared "is the experimental marketplace on for THIS
 * project?" hook that the Customize rail + section-header shortcut read.
 */

import { useQuery } from '@tanstack/react-query';

import { getProjectDetail } from '@/lib/projects-client';

/** Shared gate — is the experimental marketplace feature on for this project? */
export function useMarketplaceEnabled(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.project?.experimental?.marketplace ?? false;
}
