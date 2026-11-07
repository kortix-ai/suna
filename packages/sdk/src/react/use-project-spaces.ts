'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addWorkspaceSpaceLink,
  addWorkspaceSpaceMembers,
  joinWorkspaceSpace,
  leaveWorkspaceSpace,
  listWorkspaceSpaceMembers,
  removeWorkspaceSpaceMember,
  createWorkspaceSpace,
  getChannelsOnboarding,
  getOrCreateWorkspaceDm,
  getWorkspaceSpaceGeneralNotice,
  getPrivateChannelsAvailable,
  getWorkspaceSpaceProactive,
  markChannelsOnboarding,
  listWorkspaceSpaceApps,
  listWorkspaceSpaceLinks,
  pinWorkspaceSpaceLink,
  listWorkspaceSpaces,
  listPrivateChannelsNotIn,
  removeWorkspaceSpaceLink,
  setWorkspaceSpaceProactive,
  setWorkspaceSpaceTabs,
  updateWorkspaceSpace,
  type AddProjectSpaceLinkInput,
  type ChannelsOnboardingMark,
  type ProjectSpaceProactiveInput,
  type ProjectSpaceTab,
  type UpdateProjectSpaceInput,
} from '../core/rest/projects-client/spaces';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * The project's channels and the caller's DMs. Members create and archive
 * channels, so this is the `inventory` tier. Pass `enabled: false` while the
 * project's `chat` flag is off: the route answers 403 then.
 */
export function useWorkspaceSpaces(projectId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.spaces(projectId ?? ''),
    queryFn: () => listWorkspaceSpaces(projectId as string),
    enabled: !!projectId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

/** @deprecated Use `useWorkspaceSpaces`. Kept permanently. */
export const useProjectSpaces = useWorkspaceSpaces;

/**
 * `#general`'s "turned on again" line (`kind`, `at`, `count`), or null. Reads
 * the spaces route; its key sits under the spaces key, so a spaces refresh refreshes it.
 */
export function useWorkspaceSpaceGeneralNotice(projectId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.spaceGeneralNotice(projectId ?? ''),
    queryFn: () => getWorkspaceSpaceGeneralNotice(projectId as string),
    enabled: !!projectId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

/** @deprecated Use `useWorkspaceSpaceGeneralNotice`. Kept permanently. */
export const useProjectSpaceGeneralNotice = useWorkspaceSpaceGeneralNotice;

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
export function useCreateWorkspaceSpace(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId, true);
  return useMutation({
    mutationFn: (input: Parameters<typeof createWorkspaceSpace>[1]) => createWorkspaceSpace(projectId, input),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useCreateWorkspaceSpace`. Kept permanently. */
export const useCreateProjectSpace = useCreateWorkspaceSpace;

/** Rename, describe, archive or unarchive a channel: its creator or a project manager (`can_edit`), else 403 `forbidden`. */
export function useUpdateWorkspaceSpace(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (args: { spaceId: string; input: UpdateProjectSpaceInput }) =>
      updateWorkspaceSpace(projectId, args.spaceId, args.input),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useUpdateWorkspaceSpace`. Kept permanently. */
export const useUpdateProjectSpace = useUpdateWorkspaceSpace;

/**
 * Replace a space's tabs after Chat (`setProjectSpaceTabs`): a channel's
 * editor or a DM's owner, else 403 `forbidden`. Resolves after the spaces
 * list refetched, so the tab row shows the new list.
 */
export function useSetWorkspaceSpaceTabs(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (args: { spaceId: string; tabs: ProjectSpaceTab[] }) => setWorkspaceSpaceTabs(projectId, args.spaceId, args.tabs),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useSetWorkspaceSpaceTabs`. Kept permanently. */
export const useSetProjectSpaceTabs = useSetWorkspaceSpaceTabs;

/**
 * A space's Proactive settings (flag `spaces_proactive`): whether its watcher
 * is on, and its daily brief. Pass `enabled: false` while the flag is off:
 * the route answers 403 then. `inventory` tier.
 */
export function useWorkspaceSpaceProactive(projectId: string | null | undefined, spaceId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.spaceProactive(projectId ?? '', spaceId ?? ''),
    queryFn: () => getWorkspaceSpaceProactive(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

/** @deprecated Use `useWorkspaceSpaceProactive`. Kept permanently. */
export const useProjectSpaceProactive = useWorkspaceSpaceProactive;

/** Change a space's Proactive settings (see `setProjectSpaceProactive`); resolves after the settings refetched. */
export function useSetWorkspaceSpaceProactive(projectId: string, spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectSpaceProactiveInput) => setWorkspaceSpaceProactive(projectId, spaceId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.project.spaceProactive(projectId, spaceId) }),
  });
}

/** @deprecated Use `useSetWorkspaceSpaceProactive`. Kept permanently. */
export const useSetProjectSpaceProactive = useSetWorkspaceSpaceProactive;

/** Open the caller's DM with an agent (created on the first call). Resolves the DM space. */
export function useOpenWorkspaceDm(projectId: string) {
  const invalidate = useInvalidateSpaces(projectId, true);
  return useMutation({
    mutationFn: (agentName: string) => getOrCreateWorkspaceDm(projectId, agentName),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useOpenWorkspaceDm`. Kept permanently. */
export const useOpenProjectDm = useOpenWorkspaceDm;

type Id = string | null | undefined;

/** A channel's Apps (deployed from one of its threads). `inventory` tier, like the project's Apps. */
export function useWorkspaceSpaceApps(projectId: Id, spaceId: Id) {
  return useQuery({
    queryKey: qk.project.spaceApps(projectId ?? '', spaceId ?? ''),
    queryFn: () => listWorkspaceSpaceApps(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId,
    ...contract('inventory'),
  });
}

/** @deprecated Use `useWorkspaceSpaceApps`. Kept permanently. */
export const useProjectSpaceApps = useWorkspaceSpaceApps;

/** A channel's links, pinned and shared in its threads, the most recently shared first. */
export function useWorkspaceSpaceLinks(projectId: Id, spaceId: Id) {
  return useQuery({
    queryKey: qk.project.spaceLinks(projectId ?? '', spaceId ?? ''),
    queryFn: () => listWorkspaceSpaceLinks(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId,
    ...contract('inventory'),
  });
}

/** @deprecated Use `useWorkspaceSpaceLinks`. Kept permanently. */
export const useProjectSpaceLinks = useWorkspaceSpaceLinks;

function useInvalidateSpaceLinks(projectId: string, spaceId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: qk.project.spaceLinks(projectId, spaceId) });
}

/** Pin a link to a channel. A bad URL rejects with `ApiError` status 400; a full channel rejects with 409 `link_limit` (see `addProjectSpaceLink`). */
export function useAddWorkspaceSpaceLink(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaceLinks(projectId, spaceId);
  return useMutation({
    mutationFn: (input: AddProjectSpaceLinkInput) => addWorkspaceSpaceLink(projectId, spaceId, input),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useAddWorkspaceSpaceLink`. Kept permanently. */
export const useAddProjectSpaceLink = useAddWorkspaceSpaceLink;

/** Pin or unpin a link of a channel (see `pinProjectSpaceLink`): resolves to the link; unpinning never removes it. */
export function usePinWorkspaceSpaceLink(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaceLinks(projectId, spaceId);
  return useMutation({
    mutationFn: ({ linkId, pinned }: { linkId: string; pinned: boolean }) =>
      pinWorkspaceSpaceLink(projectId, spaceId, linkId, pinned),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `usePinWorkspaceSpaceLink`. Kept permanently. */
export const usePinProjectSpaceLink = usePinWorkspaceSpaceLink;

/** Remove a link from a channel. */
export function useRemoveWorkspaceSpaceLink(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaceLinks(projectId, spaceId);
  return useMutation({
    mutationFn: (linkId: string) => removeWorkspaceSpaceLink(projectId, spaceId, linkId),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useRemoveWorkspaceSpaceLink`. Kept permanently. */
export const useRemoveProjectSpaceLink = useRemoveWorkspaceSpaceLink;

/** A channel's people: the same list for every viewer (the header roster, the Members tab). `inventory` tier. */
export function useWorkspaceSpaceMembers(projectId: Id, spaceId: Id) {
  return useQuery({
    queryKey: qk.project.spaceMembers(projectId ?? '', spaceId ?? ''),
    queryFn: () => listWorkspaceSpaceMembers(projectId as string, spaceId as string),
    enabled: !!projectId && !!spaceId,
    ...contract('inventory'),
  });
}

/** @deprecated Use `useWorkspaceSpaceMembers`. Kept permanently. */
export const useProjectSpaceMembers = useWorkspaceSpaceMembers;

/** Add people to a channel in one request (see `addProjectSpaceMembers`); refetches the spaces list, the members under it. */
export function useAddWorkspaceSpaceMembers(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (userIds: string[]) => addWorkspaceSpaceMembers(projectId, spaceId, userIds),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useAddWorkspaceSpaceMembers`. Kept permanently. */
export const useAddProjectSpaceMembers = useAddWorkspaceSpaceMembers;

/** Remove someone from a channel (see `removeProjectSpaceMember`). */
export function useRemoveWorkspaceSpaceMember(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({
    mutationFn: (userId: string) => removeWorkspaceSpaceMember(projectId, spaceId, userId),
    onSuccess: invalidate,
  });
}

/** @deprecated Use `useRemoveWorkspaceSpaceMember`. Kept permanently. */
export const useRemoveProjectSpaceMember = useRemoveWorkspaceSpaceMember;

/** The caller joins a public channel; the spaces list then says `is_member`. */
export function useJoinWorkspaceSpace(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({ mutationFn: () => joinWorkspaceSpace(projectId, spaceId), onSuccess: invalidate });
}

/** @deprecated Use `useJoinWorkspaceSpace`. Kept permanently. */
export const useJoinProjectSpace = useJoinWorkspaceSpace;

/** The caller leaves a channel. Its creator gets 403 `creator_not_removable`. */
export function useLeaveWorkspaceSpace(projectId: string, spaceId: string) {
  const invalidate = useInvalidateSpaces(projectId);
  return useMutation({ mutationFn: () => leaveWorkspaceSpace(projectId, spaceId), onSuccess: invalidate });
}

/** @deprecated Use `useLeaveWorkspaceSpace`. Kept permanently. */
export const useLeaveProjectSpace = useLeaveWorkspaceSpace;

/**
 * The caller's Channels onboarding state: `intro_seen` and the `#general`
 * "Get started" rows. Pass `enabled: false` while `chat` is off.
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
