'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addProjectSpaceLink,
  createProjectSpace,
  getOrCreateProjectDm,
  getProjectSpaceSummary,
  listProjectSpaceApps,
  listProjectSpaceLinks,
  listProjectSpaces,
  removeProjectSpaceLink,
  updateProjectSpace,
  type AddProjectSpaceLinkInput,
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

type Id = string | null | undefined;

/** A channel's Apps (deployed from one of its threads). `inventory` tier, like the project's Apps. */
export function useProjectSpaceApps(projectId: Id, spaceId: Id) {
  return useQuery({
    queryKey: qk.project.spaceApps(projectId ?? '', spaceId ?? ''),
    queryFn: () => listProjectSpaceApps(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId,
    ...contract('inventory'),
  });
}

/** A channel's links, newest first. */
export function useProjectSpaceLinks(projectId: Id, spaceId: Id) {
  return useQuery({
    queryKey: qk.project.spaceLinks(projectId ?? '', spaceId ?? ''),
    queryFn: () => listProjectSpaceLinks(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId,
    ...contract('inventory'),
  });
}

/** The counts beside a channel's tab labels. */
export function useProjectSpaceSummary(projectId: Id, spaceId: Id) {
  return useQuery({
    queryKey: qk.project.spaceSummary(projectId ?? '', spaceId ?? ''),
    queryFn: () => getProjectSpaceSummary(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId,
    ...contract('inventory'),
  });
}

function useInvalidateSpaceLinks(projectId: string, spaceId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.spaceLinks(projectId, spaceId) }),
      queryClient.invalidateQueries({ queryKey: qk.project.spaceSummary(projectId, spaceId) }),
    ]);
}

/** Pin a link to a channel. A bad URL rejects with `ApiError` status 400; a full channel rejects with 409 `link_limit` (see `addProjectSpaceLink`). */
export function useAddProjectSpaceLink(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaceLinks(projectId, spaceId);
  return useMutation({
    mutationFn: (input: AddProjectSpaceLinkInput) => addProjectSpaceLink(projectId, spaceId, input),
    onSuccess: invalidate,
  });
}

/** Remove a link from a channel. */
export function useRemoveProjectSpaceLink(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaceLinks(projectId, spaceId);
  return useMutation({
    mutationFn: (linkId: string) => removeProjectSpaceLink(projectId, spaceId, linkId),
    onSuccess: invalidate,
  });
}
