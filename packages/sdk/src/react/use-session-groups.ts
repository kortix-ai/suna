'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProjectSessionGroup,
  deleteProjectSessionGroup,
  listProjectSessionGroups,
  renameProjectSessionGroup,
  reorderProjectSessionGroups,
  setProjectSessionGroup,
  type CreateProjectSessionGroupInput,
  type ProjectSessionGroup,
} from '../core/rest/projects-client/session-groups';
import { contract } from './query-contracts';
import { qk } from './query-keys';
import { findCachedProjectSession, refileCachedProjectSession, updateCachedProjectSessions } from './session-cache-write';

/**
 * The project's session groups, in order. Members create, rename and reorder
 * them, so this is the `inventory` tier. Pass `enabled: false` while the
 * project's `session_groups` flag is off: the route answers 403 then.
 */
export function useProjectSessionGroups(projectId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.sessionGroups(projectId ?? ''),
    queryFn: () => listProjectSessionGroups(projectId as string),
    enabled: !!projectId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

function useInvalidateSessionGroups(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: qk.project.sessionGroups(projectId) });
}

/** Create a group, last in the order. A taken name rejects with `ApiError` code `group_name_taken`. */
export function useCreateProjectSessionGroup(projectId: string) {
  const invalidate = useInvalidateSessionGroups(projectId);
  return useMutation({
    mutationFn: (input: CreateProjectSessionGroupInput) => createProjectSessionGroup(projectId, input),
    onSuccess: invalidate,
  });
}

/** Rename a group. A taken name rejects with `ApiError` code `group_name_taken`. */
export function useRenameProjectSessionGroup(projectId: string) {
  const invalidate = useInvalidateSessionGroups(projectId);
  return useMutation({
    mutationFn: (args: { groupId: string; name: string }) => renameProjectSessionGroup(projectId, args.groupId, args.name),
    onSuccess: invalidate,
  });
}

/** Delete a group. Its sessions move to no group, so the session lists refetch too. */
export function useDeleteProjectSessionGroup(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => deleteProjectSessionGroup(projectId, groupId),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.project.sessionGroups(projectId) }),
        queryClient.invalidateQueries({ queryKey: [...qk.project.sessionsScope(projectId), 'list-paged'] }),
      ]),
  });
}

/**
 * Put the groups in this order (every group id, once). The cached list shows
 * the new order at once and keeps the server's answer. A refusal (409
 * `group_order_stale`: someone added or deleted a group) puts the old order
 * back and reads the list again; the returned promise rejects.
 */
export function useReorderProjectSessionGroups(projectId: string) {
  const queryClient = useQueryClient();
  const key = qk.project.sessionGroups(projectId);
  return useMutation({
    mutationFn: (groupIds: string[]) => reorderProjectSessionGroups(projectId, groupIds),
    onMutate: async (groupIds) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProjectSessionGroup[]>(key);
      if (previous) {
        const byId = new Map(previous.map((group) => [group.group_id, group]));
        const next = groupIds.map((id, position) => byId.get(id)).filter((group): group is ProjectSessionGroup => !!group);
        queryClient.setQueryData<ProjectSessionGroup[]>(
          key,
          next.map((group, position) => ({ ...group, position })),
        );
      }
      return { previous };
    },
    onSuccess: (groups) => queryClient.setQueryData(key, groups),
    onError: (_error, _groupIds, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * File a session into a group (`groupId`) or into none (`null`). At once, every
 * cached copy carries the new `group_id`, the row leaves the cached list of
 * its old group and enters the list of its new one (page one); then the paged
 * lists refetch and put it in its place. A refusal rejects the returned
 * promise; the refetch puts the row back.
 */
export function useSetProjectSessionGroup(projectId: string) {
  const queryClient = useQueryClient();
  const write = (sessionId: string, groupId: string | null) => {
    updateCachedProjectSessions(queryClient, projectId, (sessions) =>
      sessions.map((session) => (session.session_id === sessionId ? { ...session, group_id: groupId } : session)),
    );
    const moved = findCachedProjectSession(queryClient, projectId, (session) => session.session_id === sessionId);
    if (moved) refileCachedProjectSession(queryClient, projectId, moved);
  };
  return useMutation({
    mutationFn: ({ sessionId, groupId }: { sessionId: string; groupId: string | null }) =>
      setProjectSessionGroup(projectId, sessionId, groupId),
    onMutate: ({ sessionId, groupId }) => write(sessionId, groupId),
    onSuccess: (assignment) => write(assignment.session_id, assignment.group_id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...qk.project.sessionsScope(projectId), 'list-paged'] }),
  });
}
