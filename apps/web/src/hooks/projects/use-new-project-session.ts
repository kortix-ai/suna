'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';

import { useProjectCanRun } from '@/hooks/projects/use-project-can-run';
import { isBillingEnabled } from '@/lib/config';
import { markSessionFresh } from '@/lib/fresh-sessions';
import { createProjectSession, prefetchSessionStart } from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';

/**
 * The fastest possible "new empty session" path, shared by every entry point
 * (project shell button, ⌘T/⌘J shortcuts, project sidebar, command palette).
 *
 * OPTIMISTIC: mint the session id client-side and navigate IMMEDIATELY — the
 * instant shell paints before the create POST even returns. The backend honors a
 * client-provided UUID (`session_id` is client-authoritative), and the session page's `/start` poll tolerates the sub-second
 * create-vs-start race by retrying. Provisioning + the route bundle are warmed
 * during the navigation; the session is persisted in the background.
 *
 * `onNavigate(sessionId)` runs synchronously right before the push — use it for
 * entry-point-specific side effects (open a tab, close a drawer, timing marks,
 * stashing a pending prompt so the shell auto-sends it once the box is ready).
 *
 * `create` carries create-time overrides (e.g. a chosen `sandbox_slug`) straight
 * to the persist POST without changing the optimistic timing.
 */
export function useNewProjectSession(projectId: string | undefined) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const creatingRef = useRef(false);
  const { canRun, isLoading: billingLoading, accountId } = useProjectCanRun(projectId);
  const openUpgradeDialog = useUpgradeDialogStore((state) => state.openUpgradeDialog);

  return useCallback(
    (opts?: { onNavigate?: (sessionId: string) => void; create?: { sandbox_slug?: string } }) => {
      if (!projectId || creatingRef.current) return;

      if (isBillingEnabled() && billingLoading) return;

      if (isBillingEnabled() && !canRun) {
        openUpgradeDialog({ reason: 'subscription_required', accountId });
        return;
      }

      creatingRef.current = true;

      // The API requires a UUIDv4; crypto.randomUUID is available in every
      // context this app runs (secure context: https + localhost).
      const sessionId = crypto.randomUUID();
      markSessionFresh(sessionId); // → instant shell, not the resume loader
      prefetchSessionStart(queryClient, projectId, sessionId);
      router.prefetch(`/projects/${projectId}/sessions/${sessionId}`);
      opts?.onNavigate?.(sessionId);
      router.push(`/projects/${projectId}/sessions/${sessionId}`);

      // Persist in the background — the page is already rendering the shell.
      createProjectSession(projectId, { session_id: sessionId, ...opts?.create })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        })
        .catch((err) => {
          const code = (err as { code?: string })?.code;
          // No-plan 402 → the session page itself shows the gated screen +
          // upgrade modal (its billing gate knows this project's account), so
          // stay put and let it handle the pitch.
          if (code === 'subscription_required' || code === 'no_account') return;
          // Any other terminal failure (concurrent-session limit, out-of-credits,
          // validation, server error) means the session will never exist — we've
          // already navigated optimistically, so bounce back off the dead shell.
          // The 429 cap is surfaced by the global handler; others get a toast.
          if (code !== 'concurrent_session_limit') {
            toast.error(err instanceof Error ? err.message : 'Failed to start session');
          }
          router.replace(`/projects/${projectId}`);
        })
        .finally(() => {
          creatingRef.current = false;
        });
    },
    [projectId, router, queryClient, billingLoading, canRun, accountId, openUpgradeDialog],
  );
}
