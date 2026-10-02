'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Session } from '../../core/runtime/runtime-types';
import { runtimeKeys } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Share / Unshare Hooks
// ============================================================================

/** @deprecated Wraps an OpenCode-only runtime route. Removed in the next major. */
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
      queryClient.setQueryData(runtimeKeys.runtimeSession(updatedSession.id), updatedSession);
      queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
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

/** @deprecated Wraps an OpenCode-only runtime route. Removed in the next major. */
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
      queryClient.setQueryData(runtimeKeys.runtimeSession(updatedSession.id), updatedSession);
      queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
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
