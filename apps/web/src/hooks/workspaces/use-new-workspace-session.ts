'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

import { errorToast, loadingToast } from '@/components/ui/toast';
import { createScopedSession } from '@/features/session/scope/create-scoped-session';
import type { SessionScopeCommit } from '@/features/session/scope/session-scope-model';
import {
  getRequiredConnectorConnections,
  resolveCreateFailure,
} from '@/hooks/workspaces/new-session-failure';
import { useWorkspaceCanRun } from '@/hooks/workspaces/use-workspace-can-run';
import {
  NEW_SESSION_GUARD_MAX_MS,
  hasLandedOnNewSession,
  useNewSessionGuardStore,
} from '@/hooks/workspaces/new-session-guard';
import { isBillingEnabled } from '@/lib/config';
import { useConnectorGateStore } from '@/stores/connector-gate-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import {
  createWorkspaceSession,
  getWorkspaceSessionScope,
  type PendingSessionPrompt,
  type SessionConnectorBindingsInput,
  setWorkspaceSessionScope,
} from '@kortix/sdk';
import { markSessionFresh } from '@kortix/sdk/fresh-sessions';
import { prefetchSessionStart, qk } from '@kortix/sdk/react';

/**
 * The shared workspace-session entry path. Calls without options only open the
 * composer. Calls with options create a session for an explicit task.
 *
 * Every entry point mints the session id client-side and persists it only after
 * an explicit user action. The route bundle and `/start` are prefetched before
 * navigation.
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
 *
 * Activation is guarded per workspace by `new-session-guard.ts` and held until the
 * navigation lands, so hammering the control creates exactly ONE session. Bind
 * `useIsCreatingWorkspaceSession(workspaceId)` to the control's `disabled` so the
 * guard is visible as well as enforced.
 */
/**
 * Options for a new-session start.
 * `agent_name` chooses the session's boot agent. Later prompts can name another
 * agent; the API re-scopes its grants before forwarding the prompt.
 * `connector_bindings` binds specific connections; `inherit_unbound`
 * keeps the workspace-default fallback for every OTHER connector so binding one
 * doesn't null the rest. `require_connectors` names connectors that must resolve
 * to the acting user's OWN connection — a missing one opens the connect gate.
 */
export type NewWorkspaceSessionOpts = {
  onNavigate?: (sessionId: string) => void;
  onError?: () => void;
  scope?: SessionScopeCommit;
  create?: {
    sandbox_slug?: string;
    agent_name?: string;
    pending_prompt?: PendingSessionPrompt;
    connector_bindings?: SessionConnectorBindingsInput;
    inherit_unbound?: boolean;
    require_connectors?: string[];
  };
};

export function useNewWorkspaceSession(workspaceId: string | undefined) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { canRun, isLoading: billingLoading, accountId } = useWorkspaceCanRun(workspaceId);
  const openUpgradeDialog = useUpgradeDialogStore((state) => state.openUpgradeDialog);
  const openConnectorGate = useConnectorGateStore((state) => state.openConnectorGate);
  // A ref so the connect-to-start gate's `retry` re-invokes the LATEST create fn.
  const startRef = useRef<(opts?: NewWorkspaceSessionOpts) => void>(() => {});
  // The guard is module state, not a ref: the workspace shell mounts this hook
  // three times (sidebar button, shell shortcuts, command palette) and all of
  // them must share ONE in-flight claim. See new-session-guard.ts.
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = useCallback(() => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    if (workspaceId) useNewSessionGuardStore.getState().settle(workspaceId);
  }, [workspaceId]);

  // Hold the claim until the navigation LANDS. Releasing when the create POST
  // resolves (~130ms) is what let 10 rapid clicks mint 8 sessions.
  const pendingMap = useNewSessionGuardStore((state) => state.pending);
  useEffect(() => {
    if (!workspaceId) return;
    if (hasLandedOnNewSession(pendingMap, workspaceId, pathname)) release();
  }, [pendingMap, workspaceId, pathname, release]);
  useEffect(() => () => {
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
  }, []);

  const startSession = useCallback(
    (opts?: NewWorkspaceSessionOpts) => {
      if (!workspaceId) {
        opts?.onError?.();
        return;
      }

      if (!opts) {
        router.push(`/workspaces/${workspaceId}`);
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

      // ONE claim per workspace. A second activation while the first create is
      // still settling is a no-op, not a second session.
      if (!useNewSessionGuardStore.getState().begin(workspaceId)) {
        opts?.onError?.();
        return;
      }
      releaseTimerRef.current = setTimeout(release, NEW_SESSION_GUARD_MAX_MS);

      const createSession = async () => {
        const sessionId = crypto.randomUUID();
        markSessionFresh(sessionId);
        router.prefetch(`/workspaces/${workspaceId}/sessions/${sessionId}`);
        await loadingToast(
          'Starting session…',
          createWorkspaceSession(workspaceId, {
            session_id: sessionId,
            ...opts?.create,
          }),
          { success: 'Session started' },
        );
        return sessionId;
      };

      createScopedSession({
        create: createSession,
        draft: opts?.scope?.draft,
        availability: opts?.scope?.availability,
        readScope: (sessionId) => getWorkspaceSessionScope(workspaceId, sessionId),
        replaceScope: (sessionId, replacement) =>
          setWorkspaceSessionScope(workspaceId, sessionId, replacement),
        onReady: (sessionId) => {
          // Keep the claim engaged through the navigation: the effect above
          // releases it once the browser is actually showing this session.
          useNewSessionGuardStore.getState().target(workspaceId, sessionId);
          // The row exists — kick provisioning so it overlaps the navigation.
          prefetchSessionStart(queryClient, workspaceId, sessionId);
          queryClient.invalidateQueries({ queryKey: qk.workspace.sessionsScope(workspaceId) });
          opts?.onNavigate?.(sessionId);
          router.push(`/workspaces/${workspaceId}/sessions/${sessionId}`);
        },
      })
        .catch((err) => {
          const code = (err as { code?: string })?.code;
          const action = resolveCreateFailure(code);
          if (action === 'upgrade') {
            openUpgradeDialog({ reason: 'subscription_required', accountId });
          } else if (action === 'connect') {
            const connectorConnections = getRequiredConnectorConnections(err);
            if (workspaceId && connectorConnections) {
              openConnectorGate({
                workspaceId,
                connectorConnections,
                retry: () => startRef.current(opts),
              });
            } else {
              errorToast(err instanceof Error ? err.message : 'Failed to start session');
            }
          } else if (action === 'toast') {
            errorToast(err instanceof Error ? err.message : 'Failed to start session');
          }
          // 'silent': the global 429 handler already surfaced the session cap.
          // No navigation happened, so release the claim now — the user stays
          // where they are and must be able to try again immediately.
          release();
          opts?.onError?.();
        });
    },
    [
      workspaceId,
      router,
      queryClient,
      billingLoading,
      canRun,
      accountId,
      openUpgradeDialog,
      openConnectorGate,
      release,
    ],
  );
  startRef.current = startSession;
  return startSession;
}
