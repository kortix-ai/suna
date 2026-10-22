'use client';

import { useQuery } from '@tanstack/react-query';
import { loadSavedTranscript, savedCopyEmptyRoot } from '../core/session-sync/saved-transcript';
import { qk } from './query-keys';

/** `useSession`'s saved-history read: the one transcript read of a session open. */
export function useSessionTranscriptHistory(
  projectId: string,
  sessionId: string,
  enabled: boolean,
) {
  const query = useQuery({
    queryKey: [...qk.project.session(projectId, sessionId), 'transcript-history'],
    // The session-open snapshot carries this window: one in flight is waited
    // for, so the window is downloaded once per open.
    queryFn: ({ signal }) => loadSavedTranscript(projectId, sessionId, { signal }),
    enabled: enabled && !!projectId && !!sessionId,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const data = enabled ? query.data : null;
  const envelope =
    data?.available &&
    data.source === 'mirror' &&
    (data.runtime_session_id ?? data.opencode_session_id) &&
    data.messages.length
      ? data
      : null;
  return {
    envelope,
    rootSessionId: envelope?.runtime_session_id ?? envelope?.opencode_session_id ?? null,
    /** The OpenCode root the saved copy proves empty, or null. */
    emptyRootSessionId: savedCopyEmptyRoot(data),
    /** The read has not answered yet, so `envelope: null` is not a "no". A
     *  failed read is an answer: there is no saved copy to show. */
    isLoading: enabled && query.isPending,
  };
}
