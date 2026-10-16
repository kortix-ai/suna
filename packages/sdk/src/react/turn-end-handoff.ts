'use client';

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getSessionTurn } from '../core/rest/projects-client/sessions';
import {
  type TurnEndWatch,
  type TurnEndWatchDeps,
  createTurnEndWatch,
} from '../core/session/turn-end-watch';
import { unwrapError } from '../core/turns/errors';
import { hasNotifySink, notifySessionError, notifyTaskComplete } from '../platform/ui';
import { findCachedProjectSession } from './session-cache-write';
import { realRuntimeTitle } from './use-opencode-events/helpers';
import { type Session, runtimeKeys } from './use-opencode-sessions';

/**
 * The session page's half of the turn-end hand-off (`core/session/turn-end-watch.ts`).
 *
 * While the page is mounted, its live stream announces a turn's end. When it
 * unmounts with a turn still running, this hands the turn to one watch per host,
 * which reads `/turn` until the turn ends and raises the same notification the
 * stream would have (`notifyTaskComplete` / `notifySessionError`). Mounting the
 * page again takes the turn back, so the two never both announce one end.
 */

let watch: TurnEndWatch | null = null;
let overrides: Partial<TurnEndWatchDeps> | null = null;

function announce(...[handoff, outcome, watchedSinceMs]: Parameters<TurnEndWatchDeps['onEnded']>) {
  const title = handoff.title?.();
  if (outcome.kind === 'completed') {
    notifyTaskComplete(handoff.sessionId, title, { watchedSinceMs, projectId: handoff.projectId });
  } else if (outcome.kind === 'failed') {
    // The sentence the stream path shows for a failure (`unwrapError`), never
    // the error class name.
    notifySessionError(handoff.sessionId, unwrapError(outcome.error), title, {
      projectId: handoff.projectId,
    });
  }
}

function turnEndWatch(): TurnEndWatch {
  watch ??= createTurnEndWatch({
    readTurn: getSessionTurn,
    onEnded: announce,
    ...overrides,
  });
  return watch;
}

/** Test seam: a fresh watch, with `deps` replacing the network and the clock. */
export function resetTurnEndHandoffForTests(deps?: Partial<TurnEndWatchDeps>): void {
  overrides = deps ?? null;
  watch = null;
}

/** `projectId/sessionId` of every session handed over right now. */
export function turnEndHandoffWatching(): string[] {
  return watch?.watching() ?? [];
}

/** The title the session list shows, else the runtime's own title. Read when
 *  the turn ends: a session is usually named while its first turn runs. */
function sessionTitle(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
  runtimeSessionId: string | null | undefined,
): string | undefined {
  const row = findCachedProjectSession(queryClient, projectId, (session) => session.session_id === sessionId);
  const named = row?.custom_name || row?.name;
  if (named) return named;
  if (!runtimeSessionId) return undefined;
  const runtime =
    queryClient.getQueryData<Session>(runtimeKeys.runtimeSession(runtimeSessionId)) ??
    queryClient.getQueryData<Session[]>(runtimeKeys.sessions())?.find((s) => s.id === runtimeSessionId);
  return realRuntimeTitle(runtime?.title) ?? undefined;
}

export interface TurnEndHandoffInput {
  enabled: boolean;
  projectId: string;
  sessionId: string;
  /** The runtime (OpenCode) session id, for the title fallback. */
  runtimeSessionId?: string | null;
  /** `useSessionWorking(...).state === 'working'`. */
  working: boolean;
  /** `useSessionWorking(...).serverOpenTurnToken`. */
  openTurnToken: string | null;
  /** `last_ended.turn_token` of the page's newest `/turn` read. */
  lastEndedToken: string | null;
}

/**
 * Hand a running turn over when the page unmounts (or moves to another
 * session), and take it back when the page shows the session again.
 */
export function useTurnEndHandoff(input: TurnEndHandoffInput): void {
  const queryClient = useQueryClient();
  // What the page knew at its last COMMIT. Written in a passive effect, so a
  // session switch's cleanup (which runs before this commit's effects) still
  // reads the session the page is leaving, not the one it is opening.
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  const { enabled, projectId, sessionId } = input;
  useEffect(() => {
    if (!enabled || !projectId || !sessionId) return;
    watch?.release(projectId, sessionId);
    return () => {
      const last = latest.current;
      if (!last.working || last.projectId !== projectId || last.sessionId !== sessionId) return;
      // A host with no sink (mobile, a headless SDK consumer) would poll for no one.
      if (!hasNotifySink()) return;
      const runtimeSessionId = last.runtimeSessionId;
      turnEndWatch().watch({
        projectId,
        sessionId,
        openTurnToken: last.openTurnToken,
        lastEndedToken: last.lastEndedToken,
        title: () => sessionTitle(queryClient, projectId, sessionId, runtimeSessionId),
      });
    };
  }, [enabled, projectId, sessionId, queryClient]);
}
