'use client';
import { listProjectResourceGrants } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
export function useAgentGrants(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    enabled,
    retry: false,
    ...contract('inventory'),
  });
}
