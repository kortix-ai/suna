'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createBackend, deleteBackend, listBackends } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

export const projectBackendsKey = (projectId: string | null | undefined) =>
  qk.project.backends(projectId ?? '');

/** Project backend inventory plus create and delete mutations. */
export function useProjectBackends(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectBackendsKey(projectId);
  const query = useQuery({
    queryKey,
    queryFn: () => listBackends(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
    // A new backend answers `provisioning`; poll until every backend settles.
    refetchInterval: (q) =>
      q.state.data?.some((backend) => backend.status === 'provisioning') ? 2_000 : false,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof createBackend>[1]) =>
      createBackend(projectId as string, input),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (backendId: string) => deleteBackend(projectId as string, backendId),
    onSuccess: invalidate,
  });

  return { ...query, create, remove };
}
