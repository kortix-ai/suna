'use client';

import { useEffect, useRef, useState } from 'react';
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
  } = input;

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

  const active = enabled && waking && !runtimeReachable;
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
        waking: enabled && waking,
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
  }, [enabled, waking, runtimeReachable, progress, serverGaveUp, tick]);

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
