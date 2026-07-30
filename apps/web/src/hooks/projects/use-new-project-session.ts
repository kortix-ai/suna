'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';

import { errorToast, loadingToast } from '@/components/ui/toast';
import { createScopedSession } from '@/features/session/scope/create-scoped-session';
import type { SessionScopeCommit } from '@/features/session/scope/session-scope-model';
import {
  getConnectorAuthorizationRequiredProfiles,
  resolveCreateFailure,
} from '@/hooks/projects/new-session-failure';
import { useProjectCanRun } from '@/hooks/projects/use-project-can-run';
import { warmProjectSessionKey } from '@/hooks/projects/use-warm-project-session';
import {
  buildWarmSessionClaimInput,
  resolveWarmSessionForSend,
  shouldFallbackFromWarmClaim,
} from '@/hooks/projects/warm-session-create';
import { isBillingEnabled } from '@/lib/config';
import { useConnectorGateStore } from '@/stores/connector-gate-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import {
  claimWarmProjectSession,
  createProjectSession,
  getProjectSessionScope,
  type ProjectSession,
  type SessionConnectorBindings,
  setProjectSessionScope,
} from '@kortix/sdk';
import { markSessionFresh } from '@kortix/sdk/fresh-sessions';
import { prefetchSessionStart } from '@kortix/sdk/react';

/**
 * The ONE "new empty session" path, shared by every entry point (project shell
 * button, ⌘T/⌘J shortcuts, project sidebar, command palette, home composer).
 *
 * The project index supplies its server-owned warm session. Other entry points
 * mint the session id client-side and persist it before navigation. Both paths
 * prefetch the route bundle and `/start` before navigation.
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
/**
 * Options for a new-session start.
 * `agent_name` binds the session's immutable boot agent at birth. It MUST match
 * the agent the composer sends on the first prompt — the API proxy rejects any
 * prompt whose `agent` differs with 409 AGENT_SWITCH_REQUIRES_NEW_SESSION.
 * `connector_bindings` binds specific connection profiles; `inherit_unbound`
 * keeps the project-default fallback for every OTHER connector so binding one
 * doesn't null the rest. `require_connectors` names connectors that must resolve
 * to the acting user's OWN connection — a missing one opens the connect gate.
 */
export type NewProjectSessionOpts = {
  onNavigate?: (sessionId: string) => void;
  onError?: () => void;
  scope?: SessionScopeCommit;
  create?: {
    sandbox_slug?: string;
    agent_name?: string;
    connector_bindings?: SessionConnectorBindings;
    inherit_unbound?: boolean;
    require_connectors?: string[];
  };
};

export function useNewProjectSession(
  projectId: string | undefined,
  warmSession?: Pick<ProjectSession, 'session_id'>,
  resolveWarmSession?: () => Promise<Pick<ProjectSession, 'session_id'> | undefined>,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const creatingRef = useRef(false);
  const { canRun, isLoading: billingLoading, accountId } = useProjectCanRun(projectId);
  const openUpgradeDialog = useUpgradeDialogStore((state) => state.openUpgradeDialog);
  const openConnectorGate = useConnectorGateStore((state) => state.openConnectorGate);
  // A ref so the connect-to-start gate's `retry` re-invokes the LATEST create fn.
  const startRef = useRef<(opts?: NewProjectSessionOpts) => void>(() => {});

  const startSession = useCallback(
    (opts?: NewProjectSessionOpts) => {
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

      const createNormalSession = async () => {
        const sessionId = crypto.randomUUID();
        markSessionFresh(sessionId);
        router.prefetch(`/projects/${projectId}/sessions/${sessionId}`);
        await loadingToast(
          'Starting session…',
          createProjectSession(projectId, {
            session_id: sessionId,
            ...opts?.create,
          }),
          { success: 'Session started' },
        );
        return sessionId;
      };

      const claimOrCreate = async () => {
        const selectedWarmSession = await resolveWarmSessionForSend(
          warmSession,
          resolveWarmSession,
        );
        if (!selectedWarmSession) return createNormalSession();

        router.prefetch(`/projects/${projectId}/sessions/${selectedWarmSession.session_id}`);
        try {
          const claimed = await claimWarmProjectSession(
            projectId,
            buildWarmSessionClaimInput(selectedWarmSession, opts?.create),
          );
          // A claimed warm session is every bit as new to the user as a minted
          // one — mark it, so the session page opens the instant typeable shell
          // on the strength of THIS signal rather than inferring newness from a
          // stashed prompt (which outlives the hand-off it describes).
          markSessionFresh(claimed.session_id);
          return claimed.session_id;
        } catch (error) {
          if (shouldFallbackFromWarmClaim(error)) {
            return createNormalSession();
          }
          throw error;
        }
      };

      createScopedSession({
        create: claimOrCreate,
        draft: opts?.scope?.draft,
        availability: opts?.scope?.availability,
        readScope: (sessionId) => getProjectSessionScope(projectId, sessionId),
        replaceScope: (sessionId, replacement) =>
          setProjectSessionScope(projectId, sessionId, replacement),
        onReady: (sessionId) => {
          // The row exists — kick provisioning so it overlaps the navigation.
          prefetchSessionStart(queryClient, projectId, sessionId);
          queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
          opts?.onNavigate?.(sessionId);
          router.push(`/projects/${projectId}/sessions/${sessionId}`);
          queryClient.removeQueries({
            queryKey: warmProjectSessionKey(projectId),
            exact: true,
          });
        },
      })
        .catch((err) => {
          const code = (err as { code?: string })?.code;
          const action = resolveCreateFailure(code);
          if (action === 'upgrade') {
            openUpgradeDialog({ reason: 'subscription_required', accountId });
          } else if (action === 'connect') {
            const connectorProfiles = getConnectorAuthorizationRequiredProfiles(err);
            if (projectId && connectorProfiles) {
              openConnectorGate({
                projectId,
                connectorProfiles,
                retry: () => startRef.current(opts),
              });
            } else {
              errorToast(err instanceof Error ? err.message : 'Failed to start session');
            }
          } else if (action === 'toast') {
            errorToast(err instanceof Error ? err.message : 'Failed to start session');
          }
          // 'silent': the global 429 handler already surfaced the session cap.
          opts?.onError?.();
        })
        .finally(() => {
          creatingRef.current = false;
        });
    },
    [
      projectId,
      router,
      queryClient,
      billingLoading,
      canRun,
      accountId,
      openUpgradeDialog,
      openConnectorGate,
      warmSession,
      resolveWarmSession,
    ],
  );
  startRef.current = startSession;
  return startSession;
}
