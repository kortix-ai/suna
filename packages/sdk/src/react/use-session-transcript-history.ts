'use client';

import { useQuery } from '@tanstack/react-query';
import { getSessionTranscriptSync } from '../core/rest/projects-client/sessions';
import {
  OPEN_BUNDLE_TRANSCRIPT_LIMIT,
  openBundleHistory,
  settledOpenBundle,
} from '../core/session/open-bundle';
import { savedCopyEmptyRoot } from '../core/session-sync/saved-transcript';
import { qk } from './query-keys';

export function useSessionTranscriptHistory(
  projectId: string,
  sessionId: string,
  enabled: boolean,
) {
  const query = useQuery({
    queryKey: [...qk.project.session(projectId, sessionId), 'transcript-history'],
    // The session-open snapshot carries this window. One that has already
    // answered serves it, so the window is not downloaded again. This read
    // never waits for a snapshot in flight: saved history paints from its own
    // route when the snapshot is slow.
    queryFn: ({ signal }) => {
      const bundle = settledOpenBundle(projectId, sessionId);
      return (
        (bundle && openBundleHistory(bundle)) ??
        getSessionTranscriptSync(projectId, sessionId, {
          limit: OPEN_BUNDLE_TRANSCRIPT_LIMIT,
          history: true,
          signal,
        })
      );
    },
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
