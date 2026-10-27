'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addProjectSpaceLink,
  addProjectSpaceMembers,
  joinProjectSpace,
  leaveProjectSpace,
  listProjectSpaceMembers,
  removeProjectSpaceMember,
  createProjectSpace,
  getChannelsOnboarding,
  getOrCreateProjectDm,
  getProjectSpaceGeneralNotice,
  getPrivateChannelsAvailable,
  markChannelsOnboarding,
  listProjectSpaceApps,
  listProjectSpaceLinks,
  pinProjectSpaceLink,
  listProjectSpaces,
  listPrivateChannelsNotIn,
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

/** Whether this deployment allows private channels; false until the spaces route says so. */
export function usePrivateChannelsAvailable(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.privateChannelsAvailable(projectId ?? ''),
    queryFn: () => getPrivateChannelsAvailable(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

/**
 * Project managers: the private channels they are not in (`listPrivateChannelsNotIn`).
 * Pass `enabled: false` for anyone else: the route answers 403. Under the spaces
 * key, so a rename, archive or member change refetches it.
 */
export function usePrivateChannelsNotIn(projectId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.privateChannelsNotIn(projectId ?? ''),
    queryFn: () => listPrivateChannelsNotIn(projectId as string),
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

function useInvalidateSpaceLinks(projectId: string, spaceId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: qk.project.spaceLinks(projectId, spaceId) });
}

/** Pin a link to a channel. A bad URL rejects with `ApiError` status 400; a full channel rejects with 409 `link_limit` (see `addProjectSpaceLink`). */
export function useAddProjectSpaceLink(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaceLinks(projectId, spaceId);
  return useMutation({
    mutationFn: (input: AddProjectSpaceLinkInput) => addProjectSpaceLink(projectId, spaceId, input),
    onSuccess: invalidate,
  });
}

/** Pin or unpin a link of a channel (see `pinProjectSpaceLink`): resolves to the link; unpinning never removes it. */
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

/** A channel's people: the same list for every viewer (the header roster, the Members tab). `inventory` tier. */
export function useProjectSpaceMembers(projectId: Id, spaceId: Id) {
  return useQuery({
    queryKey: qk.project.spaceMembers(projectId ?? '', spaceId ?? ''),
    queryFn: () => listProjectSpaceMembers(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId,
    ...contract('inventory'),
  });
}

/** Add people to a channel in one request (see `addProjectSpaceMembers`); refetches the spaces list, the members under it. */
export function useAddProjectSpaceMembers(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (userIds: string[]) => addProjectSpaceMembers(projectId, spaceId, userIds),
    onSuccess: invalidate,
  });
}

/** Remove someone from a channel (see `removeProjectSpaceMember`). */
export function useRemoveProjectSpaceMember(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (userId: string) => removeProjectSpaceMember(projectId, spaceId, userId),
    onSuccess: invalidate,
  });
}

/** The caller joins a public channel; the spaces list then says `is_member`. */
export function useJoinProjectSpace(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({ mutationFn: () => joinProjectSpace(projectId, spaceId), onSuccess: invalidate });
}

/** The caller leaves a channel. Its creator gets 403 `creator_not_removable`. */
export function useLeaveProjectSpace(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({ mutationFn: () => leaveProjectSpace(projectId, spaceId), onSuccess: invalidate });
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
