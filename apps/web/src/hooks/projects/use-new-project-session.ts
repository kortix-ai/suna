'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';

import { resolveCreateFailure } from '@/hooks/projects/new-session-failure';
import { useProjectCanRun } from '@/hooks/projects/use-project-can-run';
import { isBillingEnabled } from '@/lib/config';
import { toast } from '@/lib/toast';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { markSessionFresh } from '@kortix/sdk/fresh-sessions';
import { createProjectSession } from '@kortix/sdk/projects-client';
import { prefetchSessionStart } from '@kortix/sdk/react';

/**
 * The ONE "new empty session" path, shared by every entry point (project shell
 * button, ⌘T/⌘J shortcuts, project sidebar, command palette, home composer).
 *
 * CREATE-FIRST: mint the session id client-side, persist it, and navigate the
 * moment the server confirms (create is a ~15ms insert, so this is still
 * instant). The route bundle prefetch overlaps the create RTT, and `/start`
 * is prefetched the moment the row exists — so provisioning still begins
 * during the navigation, without ever racing the create POST.
 *
 * `onNavigate(sessionId)` runs synchronously right before the push — use it
 * for entry-point-specific side effects (open a tab, close a drawer, timing
 * marks, stashing a pending prompt so the shell auto-sends it once the box is
 * ready).
 *
 * `onError()` fires when the create fails (after the failure is surfaced per
 * `resolveCreateFailure`) — use it to reset an entry point's pending UI
 * (e.g. the home composer's sending spinner). No navigation has happened at
 * that point, so the user simply stays where they were.
 *
 * `create` carries create-time overrides (e.g. a chosen `sandbox_slug`)
 * straight to the persist POST.
 */
export function useNewProjectSession(projectId: string | undefined) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const creatingRef = useRef(false);
  const { canRun, isLoading: billingLoading, accountId } = useProjectCanRun(projectId);
  const openUpgradeDialog = useUpgradeDialogStore((state) => state.openUpgradeDialog);

  return useCallback(
    (opts?: {
      onNavigate?: (sessionId: string) => void;
      onError?: () => void;
      // `agent_name` binds the session's immutable boot agent at birth. It MUST
      // match the agent the composer sends on the first prompt — the API proxy
      // rejects any prompt whose `agent` differs from the session's bound agent
      // with 409 AGENT_SWITCH_REQUIRES_NEW_SESSION (sessions are agent-immutable).
      create?: { sandbox_slug?: string; agent_name?: string; base_ref?: string };
    }) => {
      if (!projectId || creatingRef.current) {
        opts?.onError?.();
        return;
      }

      if (isBillingEnabled() && billingLoading) {
        opts?.onError?.();
        return;
      }

      if (isBillingEnabled() && !canRun) {
        openUpgradeDialog({ reason: 'subscription_required', accountId });
        opts?.onError?.();
        return;
      }

      creatingRef.current = true;

      // The API requires a UUIDv4; crypto.randomUUID is available in every
      // context this app runs (secure context: https + localhost).
      const sessionId = crypto.randomUUID();
      markSessionFresh(sessionId); // → instant shell, not the resume loader
      // Warm the route bundle while the create POST is in flight.
      router.prefetch(`/projects/${projectId}/sessions/${sessionId}`);

      createProjectSession(projectId, { session_id: sessionId, ...opts?.create })
        .then(() => {
          // The row exists — kick provisioning so it overlaps the navigation.
          prefetchSessionStart(queryClient, projectId, sessionId);
          queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
          opts?.onNavigate?.(sessionId);
          router.push(`/projects/${projectId}/sessions/${sessionId}`);
        })
        .catch((err) => {
          const code = (err as { code?: string })?.code;
          const action = resolveCreateFailure(code);
          if (action === 'upgrade') {
            openUpgradeDialog({ reason: 'subscription_required', accountId });
          } else if (action === 'toast') {
            toast.error(err instanceof Error ? err.message : 'Failed to start session');
          }
          // 'silent': the global 429 handler already surfaced the session cap.
          opts?.onError?.();
        })
        .finally(() => {
          creatingRef.current = false;
        });
    },
    [projectId, router, queryClient, billingLoading, canRun, accountId, openUpgradeDialog],
  );
}
