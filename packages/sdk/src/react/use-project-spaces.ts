'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addProjectSpaceLink,
  createProjectSpace,
  getChannelsOnboarding,
  getOrCreateProjectDm,
  getProjectSpaceGeneralNotice,
  getProjectSpaceSummary,
  markChannelsOnboarding,
  listProjectSpaceApps,
  listProjectSpaceLinks,
  pinProjectSpaceLink,
  listProjectSpaces,
  removeProjectSpaceLink,
  updateProjectSpace,
  type AddProjectSpaceLinkInput,
  type ChannelsOnboardingMark,
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

/**
 * `#general`'s "turned on again" line (`kind`, `at`, `count`), or null. Reads
 * the spaces route; its key sits under the spaces key, so a spaces refresh refreshes it.
 */
export function useProjectSpaceGeneralNotice(projectId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.spaceGeneralNotice(projectId ?? ''),
    queryFn: () => getProjectSpaceGeneralNotice(projectId as string),
    enabled: !!projectId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

/**
 * Refetch the spaces list; resolves when the refetch is done, so a caller's
 * `onSuccess` (a navigation to the new channel) sees the new list.
 * `completesGetStarted`: the write also completes a "Get started" row (a new
 * channel, a DM), so the onboarding state refetches too.
 */
function useInvalidateSpaces(projectId: string, completesGetStarted = false) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.spaces(projectId) }),
      ...(completesGetStarted ? [queryClient.invalidateQueries({ queryKey: qk.project.channelsOnboarding(projectId) })] : []),
    ]);
}

/** Create a channel. A taken slug rejects with `ApiError` code `slug_taken` (see `createProjectSpace`). */
export function useCreateProjectSpace(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId, true);
  return useMutation({
    mutationFn: (input: Parameters<typeof createProjectSpace>[1]) => createProjectSpace(projectId, input),
    onSuccess: invalidate,
  });
}

/** Rename, describe, archive or unarchive a channel: its creator or a project manager (`can_edit`), else 403 `forbidden`. */
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
  const invalidate = useInvalidateSpaces(projectId, true);
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

/** A channel's links, pinned and shared in its threads, the most recently shared first. */
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

/** Pin or unpin a link of a channel (see `pinProjectSpaceLink`): resolves to the link, or null when unpinning removed it. */
export function usePinProjectSpaceLink(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaceLinks(projectId, spaceId);
  return useMutation({
    mutationFn: ({ linkId, pinned }: { linkId: string; pinned: boolean }) =>
      pinProjectSpaceLink(projectId, spaceId, linkId, pinned),
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

/**
 * The caller's Channels onboarding state: `intro_seen` and the `#general`
 * "Get started" rows. Pass `enabled: false` while `project_channels` is off.
 */
export function useChannelsOnboarding(projectId: Id, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.channelsOnboarding(projectId ?? ''),
    queryFn: () => getChannelsOnboarding(projectId as string),
    enabled: !!projectId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

/**
 * Record one onboarding mark for the caller (`channels_intro`, `get_started.dismissed`, …),
 * then refetch the state. A failed mark is silent (no default error toast):
 * the next view reads the state again and offers the mark again.
 */
export function useMarkChannelsOnboarding(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mark: ChannelsOnboardingMark) => markChannelsOnboarding(projectId, mark),
    onError: () => {},
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.project.channelsOnboarding(projectId) }),
  });
}
