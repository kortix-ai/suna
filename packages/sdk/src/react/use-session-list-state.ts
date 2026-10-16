'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  setSessionArchived,
  setSessionPinned,
  type ProjectSession,
  type SessionListState,
} from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';
import { updateCachedProjectSessions } from './session-cache-write';

type SessionListChange = { pinned: boolean } | { archived: boolean };

/** The state a change leaves, before the server answers. Archiving unpins; pinning unarchives. */
function changedState(session: ProjectSession, change: SessionListChange, now: string): SessionListState {
  if ('pinned' in change) {
    return { pinned_at: change.pinned ? (session.pinned_at ?? now) : null, archived_at: change.pinned ? null : (session.archived_at ?? null) };
  }
  return { archived_at: change.archived ? (session.archived_at ?? now) : null, pinned_at: change.archived ? null : (session.pinned_at ?? null) };
}

/**
 * Pin or archive a session in the caller's own list (KRTX-2418). Every cached
 * list and the session's own entry show the change at once; the server's
 * answer replaces it, and the paged lists refetch, so an archived session
 * leaves the list and appears under `view: 'archived'`. A refusal rejects the
 * returned promise; the refetch puts the rows back.
 */
export function useSessionListState(projectId: string) {
  const client = useQueryClient();
  const write = (sessionId: string, state: (session: ProjectSession) => SessionListState) =>
    updateCachedProjectSessions(client, projectId, (sessions) =>
      sessions.map((session) => (session.session_id === sessionId ? { ...session, ...state(session) } : session)),
    );
  const mutation = useMutation({
    mutationFn: ({ sessionId, change }: { sessionId: string; change: SessionListChange }) =>
      'pinned' in change
        ? setSessionPinned(projectId, sessionId, change.pinned)
        : setSessionArchived(projectId, sessionId, change.archived),
    onMutate: ({ sessionId, change }) => {
      const now = new Date().toISOString();
      write(sessionId, (session) => changedState(session, change, now));
    },
    onSuccess: (state, { sessionId }) => write(sessionId, () => state),
    onSettled: () =>
      client.invalidateQueries({ queryKey: [...qk.project.sessionsScope(projectId), 'list-paged'] }),
  });
  // Stable callbacks (`mutateAsync` is), so a memoized row is not re-rendered.
  const { mutateAsync, isPending } = mutation;
  const actions = useMemo(
    () => ({
      setPinned: (sessionId: string, pinned: boolean) => mutateAsync({ sessionId, change: { pinned } }),
      setArchived: (sessionId: string, archived: boolean) => mutateAsync({ sessionId, change: { archived } }),
    }),
    [mutateAsync],
  );
  return { ...actions, isPending };
}
