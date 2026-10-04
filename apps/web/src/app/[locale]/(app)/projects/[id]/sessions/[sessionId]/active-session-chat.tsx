'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

import { AppErrorCard, ClientErrorBoundary } from '@/components/common/error-boundary';
import { resolvePinnedRootSessionId } from '@/features/session/pinned-root-session';
import { SessionChat } from '@/features/session/session-chat';
import { SessionLayout } from '@/features/session/session-layout';
import {
  gatedRuntimeBootError,
  gatedRuntimeError,
  runtimeErrorPresentation,
  sessionErrorSurfaceReady,
} from '@/features/session/session-load-state';
import {
  deleteRuntimeSessionParam,
  readRuntimeSessionParam,
} from '@/features/session/tool/tools/session-spawn-urls';
import { useRestartProjectSession } from '@/hooks/projects/use-restart-project-session';
import { finishSessionTiming, sessionMark } from '@/lib/session-timing';
import { formatRuntimeError } from '@kortix/sdk';
import {
  type UseSessionResult,
  migrateStash,
  qk,
  useRuntimeConnectionStore,
} from '@kortix/sdk/react';

import { InlineSessionError, RestartSessionButton } from './session-route-cards';

/**
 * Renders SessionLayout + SessionChat against this project session's sandbox.
 * `useSession` owns the canonical runtime session and the optional REST session
 * list used by child-session deep links (`?rs`; pre-W4 links say `?oc`).
 */
export function ActiveSessionChat({
  projectId,
  sessionId,
  sessionState,
  boundAgentName,
  chatReady,
  onChatReady,
  readOnly,
  inputReplacement,
}: {
  projectId: string;
  sessionId: string;
  sessionState: UseSessionResult;
  /** The session's immutable creation agent, resolved by the page (sessions
   *  list row, falling back to /start's `agent_name`). */
  boundAgentName?: string | null;
  /** The route has crossfaded onto this chat. Until then it is painted behind
   *  an opaque overlay and must not take focus — see `deferComposerFocus`. */
  chatReady?: boolean;
  onChatReady?: () => void;
  /** Read the conversation only: no composer (a terminal state). */
  readOnly?: boolean;
  /** Drawn in the composer's slot while `readOnly`: the terminal state's notice. */
  inputReplacement?: ReactNode;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const runtimeReady = useRuntimeConnectionStore(
    (s) => s.status === 'connected' && s.healthy === true,
  );
  const rawRuntimeBootError = useRuntimeConnectionStore((s) => s.runtimeError);
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();

  const rootSessionId = sessionState.runtimeSessionId;
  const runtimeSessions = sessionState.runtimeSessions;
  const sessionsLoading = sessionState.runtimeSessionsLoading;
  const sessionsListed = sessionState.runtimeSessionsListed;
  // Gate on `phase`, not the raw field: `sessionState.runtimeError` can be a
  // benign 503 racing a live `/start` wake (a parked sandbox resuming), which
  // `derivePhase` (@kortix/sdk) holds as `'starting'` until `/start` itself
  // settles or gives up (~61.5s worst case). Reading the raw field rendered
  // the panic card — and marked the chat showable below, ending the loading
  // skeleton with nothing to show — for every such race; `phase === 'error'`
  // is the SDK's own answer to "is this real." `sessionErrorSurfaceReady` below
  // gets this SAME gated value, so both consumers agree.
  const runtimeError = gatedRuntimeError({
    phase: sessionState.phase,
    runtimeError: sessionState.runtimeError,
  });
  // Same phase gate for the connection store's boot error: a genuine
  // `boot_error` still may not paint a terminal card while `/start` is in
  // flight (`phase === 'starting'`). Routine boot progress never reaches this
  // field any more (SDK `runtimeErrorFromHealth`), so on a normal cold boot
  // this is already null — this gate covers the real-failure case (RC-1).
  const runtimeBootError = gatedRuntimeBootError({
    phase: sessionState.phase,
    runtimeBootError: rawRuntimeBootError,
  });

  const restart = useRestartProjectSession(projectId, sessionId);

  const selectedRuntimeSessionId = readRuntimeSessionParam(searchParams);
  const selectedSession = selectedRuntimeSessionId
    ? runtimeSessions.find((session) => session.id === selectedRuntimeSessionId)
    : null;
  // Pin the resolved root id so the chat keeps its identity if the live
  // value blips back to null mid-session — but FOLLOW a non-null change: the
  // SDK's pin precedence only climbs, so a different resolved id is a
  // higher-authority correction (e.g. a stale persisted mirror displaced by
  // the real /start pin) and holding the old latch would keep painting — and
  // delivering into — the conversation the stale pin named. See
  // resolvePinnedRootSessionId. State, not a ref written during render: this
  // component is already keyed per session by the route, so there is no
  // cross-session reset to hand-roll, and a discarded render can no longer
  // leave a pin behind that the state it belongs to never saw.
  const [pinnedRootSessionId, setPinnedRootSessionId] = useState<string | null>(null);
  useEffect(() => {
    const next = resolvePinnedRootSessionId(pinnedRootSessionId, rootSessionId);
    if (next !== pinnedRootSessionId) setPinnedRootSessionId(next);
  }, [pinnedRootSessionId, rootSessionId]);
  const chatSessionId = selectedSession?.id ?? pinnedRootSessionId ?? rootSessionId ?? null;
  const runtimePresentation = runtimeErrorPresentation({
    chatSessionId,
    runtimeError,
    runtimeBootError,
  });

  // Migrate the home-composer prompt onto the canonical SDK start-stash. Every
  // producer (project-home composer, `useConfigureThread`, the instant shell)
  // stashes under the ROUTE session id, before the canonical OpenCode session
  // exists; once it resolves, hand the stash off to `chatSessionId`'s stash,
  // which `readStartStash` (SessionChat's pending-prompt effect, or
  // `useSession`'s own replay) reads uniformly. `migrateStash` understands both
  // the canonical shape and any producer that still writes the older bare-prompt
  // legacy shape at the route id.
  //
  // In an effect, not during render — SessionChat's replay retries the read
  // across exactly this write race (`writeRaceAttempts`), so arriving a tick
  // later costs nothing, and a render React discards can no longer move a user's
  // prompt into a namespace the surviving state knows nothing about. This
  // component only mounts once a fresh session's first message has been stashed
  // (see `shouldMountSessionChat`), so mount-time is never too early.
  useEffect(() => {
    if (!chatSessionId) return;
    migrateStash(sessionId, chatSessionId);
    // No queue hand-off beside it any more. The browser queue was keyed by the
    // OpenCode session id, which changes as the pin resolves, so the instant
    // shell's messages had to be moved from the route id onto the pin or they
    // were orphaned (#6110). The inbox is keyed by the KORTIX session id — the
    // route id — which never changes, so there is nothing to adopt.
  }, [sessionId, chatSessionId]);

  // ── Readiness benchmarking marks ───────────────────────────────────────
  useEffect(() => {
    if (runtimeReady) sessionMark(sessionId, 'runtime-ready');
  }, [runtimeReady, sessionId]);
  useEffect(() => {
    if (sessionsListed) sessionMark(sessionId, 'opencode-listed');
  }, [sessionsListed, sessionId]);
  useEffect(() => {
    if (!chatSessionId) return;
    sessionMark(sessionId, 'chat-ready');
    const sb = queryClient.getQueryData<{ metadata?: Record<string, unknown> }>(
      qk.project.sessionSandbox(projectId, sessionId),
    );
    finishSessionTiming(sessionId, sb?.metadata?.provisionTimeline);
  }, [chatSessionId, sessionId, projectId, queryClient]);

  // The ERROR surfaces below are ready the moment they exist — they render an
  // `InlineSessionError` immediately, so holding the shell over one would just
  // hide the message. The conversation is not: `chatSessionId` resolving only
  // means SessionChat can MOUNT, and for a beat after that it still paints its
  // own compact "starting" loader. Crossfading onto that loader replaced the
  // instant shell's live thread — the user's bubble and its "Thinking" row —
  // with a spinner, then swapped again a moment later. So the chat's own
  // `onContentReady` drives the fade for the ordinary path, and this covers the
  // two terminal ones.
  const errorSurfaceReady = runtimePresentation.replaceSession
    ? sessionErrorSurfaceReady({ runtimeError, runtimeBootError })
    : false;
  useEffect(() => {
    if (errorSurfaceReady) onChatReady?.();
  }, [errorSurfaceReady, onChatReady]);

  useEffect(() => {
    if (!selectedRuntimeSessionId) return;
    if (selectedSession) return;
    if (sessionsLoading) return;
    const params = new URLSearchParams(searchParams.toString());
    deleteRuntimeSessionParam(params);
    const query = params.toString();
    // `history.replaceState`, not `router.replace`: this only drops an `rs` key
    // the page has already resolved to nothing, so there is no server data to
    // fetch. Dropping a param changes the router cache key, so `router.replace`
    // would run a cold RSC fetch mid-boot — the worst moment on the hottest
    // route. Next patches `replaceState` and updates its own canonical URL, so
    // `useSearchParams` still reports the stripped URL and this effect settles
    // on its next run. Same mechanism as `openTabAndNavigate` in
    // `stores/tab-store.ts`.
    window.history.replaceState(
      null,
      '',
      query
        ? `/projects/${projectId}/sessions/${sessionId}?${query}`
        : `/projects/${projectId}/sessions/${sessionId}`,
    );
  }, [
    selectedRuntimeSessionId,
    selectedSession,
    sessionsLoading,
    searchParams,
    projectId,
    sessionId,
  ]);

  if (!runtimeReady && runtimeBootError && runtimePresentation.replaceSession) {
    return (
      <InlineSessionError
        title={tHardcodedUi.raw(
          'appProjectsIdSessionsSessionidPage.line380JsxAttrTitleOpencodeRuntimeIsNotReady',
        )}
        message={tHardcodedUi.raw(
          'appProjectsIdSessionsSessionidPage.line381JsxAttrMessageTheSandboxBootedButTheProjectRuntimeDid',
        )}
        detail={restart.errorMessage ?? runtimeBootError}
        action={<RestartSessionButton restart={restart} onRestart={restart.restart} />}
      />
    );
  }

  if (runtimeError && runtimePresentation.replaceSession) {
    const formatted = formatRuntimeError(runtimeError);
    return (
      <InlineSessionError
        title={formatted.title}
        message={formatted.message}
        detail={restart.errorMessage ?? formatted.detail}
        action={<RestartSessionButton restart={restart} onRestart={restart.restart} />}
      />
    );
  }

  if (!chatSessionId) {
    return null;
  }

  return (
    <SessionLayout
      key={chatSessionId}
      sessionId={chatSessionId}
      projectId={projectId}
      projectSessionId={sessionId}
    >
      {/* A crash in the chat is a RESOLUTION of this layer, and the route has to
          hear about it. `onChatReady` is otherwise the only thing that lowers
          the boot overlay, and it is reported by `SessionChat` itself — so a
          `SessionChat` that throws could never report it, and the overlay stayed
          at full opacity forever with its 1s boot clock still ticking. The user
          got a permanent "Connecting" spinner over a crash that had already
          happened, and no way out but a page reload. */}
      <ClientErrorBoundary
        fallback={({ error, reset }) => (
          <SessionChatCrashCard error={error} reset={reset} onSettled={onChatReady} />
        )}
      >
        <SessionChat
          key={chatSessionId}
          sessionId={chatSessionId}
          projectSessionId={sessionId}
          projectId={projectId}
          boundAgentName={boundAgentName}
          onContentReady={onChatReady}
          deferComposerFocus={!chatReady}
          sessionState={chatSessionId === sessionState.runtimeSessionId ? sessionState : undefined}
          readOnly={readOnly}
          inputReplacement={inputReplacement}
        />
      </ClientErrorBoundary>
    </SessionLayout>
  );
}

/**
 * The chat's crash card, plus the one thing the card alone cannot say: this
 * layer is done resolving, so stop covering it.
 *
 * `onSettled` fires in an effect rather than during render because it drives a
 * `setState` in the route above — calling it while rendering the fallback would
 * be a render-phase update of a different component.
 *
 * It deliberately does NOT reset itself: the boundary keeps the error until the
 * user chooses. `reset()` remounts `SessionChat`, which then reports readiness
 * again through its own path.
 */
function SessionChatCrashCard({
  error,
  reset,
  onSettled,
}: {
  error: Error;
  reset: () => void;
  onSettled?: () => void;
}) {
  useEffect(() => {
    onSettled?.();
  }, [onSettled]);
  return <AppErrorCard error={error} reset={reset} />;
}
