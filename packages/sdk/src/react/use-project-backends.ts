'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createBackend,
  createBackendSnapshot,
  deleteBackend,
  getBackendBackups,
  listBackends,
  resizeBackend,
  restoreBackendSnapshot,
} from '../core/rest/projects-client';
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
    // Poll while a backend provisions or runs an operation (a resize).
    refetchInterval: (q) =>
      q.state.data?.some((backend) => backend.status === 'provisioning' || backend.operation) ? 2_000 : false,
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

  const resize = useMutation({
    mutationFn: ({ backendId, ...size }: { backendId: string } & Parameters<typeof resizeBackend>[2]) =>
      resizeBackend(projectId as string, backendId, size),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: ({ backendId, snapshotId }: { backendId: string; snapshotId: string }) =>
      restoreBackendSnapshot(projectId as string, backendId, snapshotId),
    onSuccess: invalidate,
  });

  return { ...query, create, remove, resize, restore };
}

/** Automatic backup state and snapshots of one backend, plus a take-snapshot mutation. */
export function useProjectBackendBackups(
  projectId: string | null | undefined,
  backendId: string | null | undefined,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const queryKey = qk.project.backendBackups(projectId ?? '', backendId ?? '');
  const query = useQuery({
    queryKey,
    queryFn: () => getBackendBackups(projectId as string, backendId as string),
    enabled: !!projectId && !!backendId && enabled,
    ...contract('inventory'),
  });
  const snapshot = useMutation({
    mutationFn: () => createBackendSnapshot(projectId as string, backendId as string),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  return { ...query, snapshot };
}
