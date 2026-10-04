'use client';

/**
 * Runtime recovery for the chat thread — owns the restart mutation, the down
 * state, and the one-shot auto-reconnect guard, so Thread renders messages and
 * inputs only.
 *
 * Sandboxes idle-stop (and die) in the real world. Rather than silently
 * disabling the composer (so Enter "does nothing"), surface the state and
 * recover: restart() wakes the box and re-arms useSession's /start poll.
 */

import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import type { UseSessionResult } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useEffect, useRef } from 'react';

export function useRuntimeRecovery(session: UseSessionResult) {
  const qc = useQueryClient();
  const restart = useMutation({
    mutationFn: () => kortix.session(session.projectId, session.sessionId).restart(),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: qk.sessionStart(session.projectId, session.sessionId),
      });
      toast.success('Reconnecting the runtime…');
    },
    onError: () => toast.error('Could not reconnect the runtime'),
  });

  const runtimeReady = session.runtimePhase === 'ready';
  // "Down" = was connected, now confirmed unreachable (a drop, not the initial boot).
  const runtimeDown = session.switched && session.runtimePhase === 'unreachable';

  // Auto-reconnect ONCE per down-episode. The ref guard prevents a restart loop
  // on a box that can't recover; the flag resets when the runtime comes back, so
  // a later drop is retried again.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (!runtimeDown) {
      autoTriedRef.current = false;
      return;
    }
    if (autoTriedRef.current || restart.isPending) return;
    autoTriedRef.current = true;
    restart.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeDown]);

  return { restart, runtimeReady, runtimeDown };
}
