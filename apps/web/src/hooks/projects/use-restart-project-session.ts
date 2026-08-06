'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { errorToast } from '@/components/ui/toast';
import { restartProjectSession, sessionStartKey } from '@kortix/sdk';
import { clearRuntimeEnsureGuard, qk } from '@kortix/sdk/react';

/** The optimistic `/start` payload a restart puts in the cache on click. */
export function restartPendingStartSeed() {
  return {
    stage: 'provisioning' as const,
    retriable: true,
    sandbox: null,
    opencode_session_id: null,
    reason: 'restart_requested',
  };
}

/** One sentence for the card + toast, whatever `POST /restart` rejected with. */
export function restartFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message || 'Restart failed. Try again in a moment.';
}

/**
 * THE restart control's behavior, shared by every "Restart session" button.
 *
 * Three things every call site needs and each hand-rolled copy got wrong in a
 * different way:
 *
 * 1. **Leave the terminal card on click.** `onMutate` seeds the `/start` cache
 *    with a `provisioning` stage, so the failure card is replaced by the boot
 *    loader immediately instead of sitting there — enabled and unchanged — for
 *    the ~2.6s the restart POST + first `/start` take. That window is what made
 *    the button read as dead and invited repeat clicks.
 * 2. **Never swallow the rejection.** `POST /restart` answers 400 (unsupported
 *    provider), 403 (not the owner), 409 (`SESSION_RUNTIME_IDENTITY_UNAVAILABLE`)
 *    and 503 (`KORTIX_URL_UNREACHABLE`). With no `onError` the spinner blinked
 *    and nothing else happened — literally "nothing happens when you click
 *    restart". Now the optimistic seed is rolled back and the reason is toasted
 *    AND returned as `errorMessage` for the card's `detail` line.
 * 3. **Refresh what a restart invalidates** — the runtime guard, the OpenCode
 *    query family, `/start`, the session-sandbox row, and the sidebar list.
 */
export function useRestartProjectSession(projectId: string, sessionId: string) {
  const queryClient = useQueryClient();
  const startKey = sessionStartKey(projectId, sessionId);

  const mutation = useMutation({
    mutationFn: () => restartProjectSession(projectId, sessionId),
    onMutate: () => {
      const previous = queryClient.getQueryData(startKey);
      queryClient.setQueryData(startKey, restartPendingStartSeed());
      return { previous };
    },
    onSuccess: () => {
      clearRuntimeEnsureGuard();
      queryClient.removeQueries({ queryKey: ['opencode'] });
      queryClient.invalidateQueries({ queryKey: startKey });
      queryClient.invalidateQueries({
        queryKey: ['project', 'session-sandbox', projectId, sessionId],
      });
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
    onError: (error, _vars, context) => {
      // Put the real state back: an optimistic `provisioning` seed left behind
      // by a REJECTED restart would spin the boot loader forever.
      if (context?.previous !== undefined) queryClient.setQueryData(startKey, context.previous);
      else queryClient.invalidateQueries({ queryKey: startKey });
      errorToast(restartFailureMessage(error));
    },
  });

  return {
    restart: () => mutation.mutate(),
    isPending: mutation.isPending,
    errorMessage: mutation.error ? restartFailureMessage(mutation.error) : null,
  };
}
