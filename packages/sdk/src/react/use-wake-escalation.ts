'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { qk } from './query-keys';
import { useSessionStreamConnected } from './use-session-stream';
import {
  advanceWakeEscalation,
  initialWakeEscalationState,
  wakeEscalationAttemptSummary,
  wakeEscalationNote,
  type WakeEscalationLimits,
  type WakeEscalationState,
} from '../core/session/wake-escalation';

export interface UseWakeEscalationInput {
  /** Switch the ladder off entirely (no user, gated, not this session's view). */
  enabled?: boolean;
  /** A wake is applicable: this session's runtime is being brought up. */
  waking: boolean;
  /**
   * The RUNTIME answered — daemon health, never the session row. See the
   * module comment on `core/session/wake-escalation.ts` for why this is a
   * separate input from `waking`.
   */
  runtimeReachable: boolean;
  /** Everything observable about the wake, from `wakeProgressFingerprint`. */
  progress: string;
  /** The server declared the wake failed (the old terminal-card state). */
  serverGaveUp: boolean;
  /** Re-issue `/start`. Cheap, and it heals a row that recovered on its own. */
  onRetryStart: () => void;
  /** `POST /restart` — the thing the human always clicks. */
  onRestart: () => void;
  limits?: WakeEscalationLimits;
  /**
   * The session this view shows (R5.3). While its stream is connected and the
   * server reports its wake ladder (`kortix.control.runtime` `wake_ladder`),
   * the SERVER runs the ladder: this hook returns its state and dispatches
   * nothing. The client machine above is the fallback without the stream.
   */
  projectId?: string;
  sessionId?: string;
}

/** The server wake ladder, as `kortix.control.runtime` carries it. */
export interface ServerWakeLadder {
  status: 'idle' | 'waking' | 'escalating' | 'exhausted';
  retried: boolean;
  restarts: number;
  max_restarts: number;
  silent_since: string | null;
}

/** The server ladder in the view shape hosts already render. Pure. */
export function wakeEscalationViewFromServer(ladder: ServerWakeLadder, nowMs: number): WakeEscalationView {
  const attempts: WakeEscalationState['attempts'] = [
    ...(ladder.retried ? [{ step: 'retry-start' as const, atMs: 0 }] : []),
    ...Array.from({ length: ladder.restarts }, () => ({ step: 'restart' as const, atMs: 0 })),
  ];
  const silentSince = ladder.silent_since ? Date.parse(ladder.silent_since) : Number.NaN;
  const state = {
    ...initialWakeEscalationState,
    status: ladder.status,
    attempts,
    msSinceProgress: Number.isFinite(silentSince) ? Math.max(0, nowMs - silentSince) : 0,
  } as WakeEscalationState;
  return {
    status: state.status,
    attempts,
    attemptNumber: attempts.length + 1,
    note: wakeEscalationNote(state),
    exhausted: state.status === 'exhausted',
    summary: wakeEscalationAttemptSummary(state),
    msSinceProgress: state.msSinceProgress,
  };
}

export interface WakeEscalationView {
  status: WakeEscalationState['status'];
  attempts: WakeEscalationState['attempts'];
  /** 1 for the original wake, 2 for the first ladder action, and so on. */
  attemptNumber: number;
  /** Honest status line while escalating, or null. */
  note: string | null;
  /** The ladder is spent; the host may now render a terminal card. */
  exhausted: boolean;
  /** What was tried, for that card. Null until exhausted. */
  summary: string | null;
  /**
   * How long the wake has shown no observable change. THE progress-aware
   * budget: a host must render against this, never against time since the wake
   * began.
   */
  msSinceProgress: number;
}

/** Re-evaluate this often, because silence produces no input change of its own. */
const WAKE_TICK_MS = 1_000;

/**
 * Drive the wake escalation ladder (`core/session/wake-escalation.ts`) from a
 * session view, and dispatch its actions through the two callbacks the host
 * already owns.
 *
 * All the policy is in the pure machine; this is the `setInterval` + effect
 * glue, kept deliberately thin because the repo has no harness to render-test a
 * hook directly (same reasoning as `useRuntimeReconnect`).
 */
export function useWakeEscalation(input: UseWakeEscalationInput): WakeEscalationView {
  const {
    enabled = true,
    waking,
    runtimeReachable,
    progress,
    serverGaveUp,
    onRetryStart,
    onRestart,
    limits,
    projectId = '',
    sessionId = '',
  } = input;

  const streamConnected = useSessionStreamConnected(projectId, sessionId);
  const runtimeControl = useQuery<{ wake_ladder?: ServerWakeLadder } | null>({
    queryKey: qk.project.sessionRuntimeControl(projectId, sessionId),
    queryFn: () => null,
    enabled: false,
  }).data;
  const serverLadder = streamConnected ? (runtimeControl?.wake_ladder ?? null) : null;

  const [state, setState] = useState<WakeEscalationState>(initialWakeEscalationState);
  const stateRef = useRef(state);
  const [tick, setTick] = useState(0);

  // Callbacks through a ref: a host that rebuilds them every render must not
  // re-run the decision effect, which would re-read the clock and could dispatch
  // twice for one transition. Written in an effect declared BEFORE the decision
  // effect (React runs them in order), never during render.
  const actionsRef = useRef({ onRetryStart, onRestart });
  const limitsRef = useRef(limits);
  useEffect(() => {
    actionsRef.current = { onRetryStart, onRestart };
    limitsRef.current = limits;
  });

  const serverActive =
    serverLadder !== null && (serverLadder.status === 'waking' || serverLadder.status === 'escalating');
  const active = serverLadder ? serverActive : enabled && waking && !runtimeReachable;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((value) => value + 1), WAKE_TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    const next = advanceWakeEscalation(
      stateRef.current,
      {
        nowMs: Date.now(),
        // The server runs the ladder while it reports one: no client step.
        waking: enabled && waking && !serverLadder,
        runtimeReachable,
        progress,
        serverGaveUp,
      },
      limitsRef.current,
    );
    stateRef.current = next;
    setState(next);
    if (next.dispatch === 'retry-start') actionsRef.current.onRetryStart();
    else if (next.dispatch === 'restart') actionsRef.current.onRestart();
  }, [enabled, waking, runtimeReachable, progress, serverGaveUp, tick, serverLadder]);

  if (serverLadder) return wakeEscalationViewFromServer(serverLadder, Date.now());
  return {
    status: state.status,
    attempts: state.attempts,
    attemptNumber: state.attempts.length + 1,
    note: wakeEscalationNote(state),
    exhausted: state.status === 'exhausted',
    summary: wakeEscalationAttemptSummary(state),
    msSinceProgress: state.msSinceProgress,
  };
}
