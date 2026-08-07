'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/** Fail-closed project gate for every Apps discovery and page surface. */
export function useAppsFeatureEnabled(projectId: string | null | undefined): {
  enabled: boolean;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  return {
    enabled: query.data?.project?.experimental?.apps === true,
    isLoading: query.isLoading,
  };
}
