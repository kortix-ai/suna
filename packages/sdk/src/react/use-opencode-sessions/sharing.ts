'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../opencode/client';
import type { Session } from '../../runtime/wire-types';
import { opencodeKeys } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Share / Unshare Hooks
// ============================================================================

export function useShareSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
      const result = await client.session.share({ sessionID: sessionId });
      return unwrap(result) as Session;
    },
    onSuccess: (updatedSession) => {
      // Surgically update cache with share info
      queryClient.setQueryData(opencodeKeys.session(updatedSession.id), updatedSession);
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        const idx = old.findIndex((s) => s.id === updatedSession.id);
        if (idx < 0) return old;
        const next = [...old];
        next[idx] = updatedSession;
        return next;
      });
    },
  });
}

export function useUnshareSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
      const result = await client.session.unshare({ sessionID: sessionId });
      return unwrap(result) as Session;
    },
    onSuccess: (updatedSession) => {
      // Surgically update cache with unshare info
      queryClient.setQueryData(opencodeKeys.session(updatedSession.id), updatedSession);
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        const idx = old.findIndex((s) => s.id === updatedSession.id);
        if (idx < 0) return old;
        const next = [...old];
        next[idx] = updatedSession;
        return next;
      });
    },
  });
}
