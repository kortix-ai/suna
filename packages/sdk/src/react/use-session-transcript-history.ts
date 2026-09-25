'use client';

import { useQuery } from '@tanstack/react-query';
import { getSessionTranscriptSync } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';

export function useSessionTranscriptHistory(
  projectId: string,
  sessionId: string,
  enabled: boolean,
) {
  const query = useQuery({
    queryKey: [...qk.project.session(projectId, sessionId), 'transcript-history'],
    queryFn: ({ signal }) =>
      getSessionTranscriptSync(projectId, sessionId, {
        limit: 40,
        history: true,
        signal,
      }),
    enabled: enabled && !!projectId && !!sessionId,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const data = enabled ? query.data : null;
  const envelope =
    data?.available && data.source === 'mirror' && data.opencode_session_id && data.messages.length
      ? data
      : null;
  return {
    envelope,
    rootSessionId: envelope?.opencode_session_id ?? null,
    /** The read has not answered yet, so `envelope: null` is not a "no". A
     *  failed read is an answer: there is no saved copy to show. */
    isLoading: enabled && query.isPending,
  };
}
