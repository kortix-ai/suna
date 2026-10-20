'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProjectSpace,
  getOrCreateProjectDm,
  listProjectSpaces,
  updateProjectSpace,
  type UpdateProjectSpaceInput,
} from '../core/rest/projects-client/spaces';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * The project's channels and the caller's DMs. Members create and archive
 * channels, so this is the `inventory` tier. Pass `enabled: false` while the
 * project's `project_channels` flag is off: the route answers 403 then.
 */
export function useProjectSpaces(projectId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.spaces(projectId ?? ''),
    queryFn: () => listProjectSpaces(projectId as string),
    enabled: !!projectId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

function useInvalidateSpaces(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: qk.project.spaces(projectId) });
}

/** Create a channel. A taken slug rejects with `ApiError` code `slug_taken` (see `createProjectSpace`). */
export function useCreateProjectSpace(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (input: Parameters<typeof createProjectSpace>[1]) => createProjectSpace(projectId, input),
    onSuccess: invalidate,
  });
}

/** Rename, describe, archive or unarchive a channel. */
export function useUpdateProjectSpace(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (args: { spaceId: string; input: UpdateProjectSpaceInput }) =>
      updateProjectSpace(projectId, args.spaceId, args.input),
    onSuccess: invalidate,
  });
}

/** Open the caller's DM with an agent (created on the first call). Resolves the DM space. */
export function useOpenProjectDm(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (agentName: string) => getOrCreateProjectDm(projectId, agentName),
    onSuccess: invalidate,
  });
}
