/**
 * The wake escalation ladder — what a session view does when bringing a
 * runtime up takes longer than it should.
 *
 * ## The failure this replaces
 *
 * Opening a stopped session starts a wake. The old model gave that wake a FIXED
 * budget: the server's own `RUNTIME_WAKE_LEASE_MS` (240s,
 * `apps/api/src/projects/session-lifecycle/runtime-wake-fence.ts:10`), after
 * which maintenance stamps `stopReason: 'runtime_wake_failed'` and every
 * subsequent `/start` short-circuits to a terminal payload
 * (`apps/api/src/projects/routes/shared.ts:672-694`)
 *
 *     "Couldn't start session <id> — The session runtime did not become
 *      reachable. Restart the session to try again."
 *
 * Measured on Essentia (2026-08-26, box `inqwpv4a1cc1kynlg46k8`): that card
 * painted while the box was SECONDS from ready — its daemon logged
 * `opencode ready` at 06:10:02, right after the budget expired. The card is a
 * dead end with no auto-recovery, and the human's fix is always the same one
 * click: "clicking restart made it work instantly". Two more recurrences
 * followed, both during a post-deploy image rebuild — i.e. this class recurs on
 * every ops event that slows a provider resume.
 *
 * ## The two rules that fix it
 *
 * 1. **A budget measures SILENCE, not elapsed time.** A wake that is visibly
 *    advancing — provider state moving, daemon boot phases changing, health
 *    improving — has not failed, however long it takes. Only a bounded window
 *    with ZERO observable change is evidence of a wedge. So the clock here is
 *    reset by any change to {@link WakeObservation.progress} and the elapsed
 *    total is never consulted.
 *
 * 2. **Escalate through the ladder the human uses, and only then give up.**
 *    A quiet `/start` retry first (free, and it heals a row that recovered on
 *    its own), then the RESTART the user would have clicked — bounded to
 *    {@link WAKE_MAX_RESTARTS}. The terminal card is what remains after the
 *    ladder is exhausted, and it then has to name what was tried
 *    ({@link wakeEscalationAttemptSummary}).
 *
 * A blanket "just restart it by default" was considered and REJECTED: it
 * destroys fast warm resumes (a Platinum CoW resume reaches `running` in ~1.9s)
 * by throwing away a box that was about to answer.
 *
 * ## Why `runtimeReachable` is a separate input from `waking`
 *
 * The session row is NOT proof the runtime is up. Observed on Essentia the same
 * day: `POST …/start` answered 202 and the row stayed `running` for 5+ minutes
 * while the E2B resume had silently failed — the provider reported the sandbox
 * `stopped` and the daemon proxy answered `503 sandbox_not_ready`. A ladder that
 * treated `stage: 'ready'` as the end of the wake would sit there forever. So
 * the wake ends when the RUNTIME ANSWERS (`/kortix/health`), not when the
 * control plane says it should have.
 *
 * That reachability is also a LATCH: once a runtime has answered, this machine
 * is done for the life of the session view. A box that drops mid-session is
 * `useRuntimeReconnect`'s problem, and auto-restarting it would destroy the
 * turn the user is watching.
 *
 * Pure and clock-free: every decision is a function of the passed state plus one
 * observation. The React glue lives in `react/use-wake-escalation.ts`.
 */

/**
 * How long a wake may show ZERO observable change before the ladder escalates.
 *
 * Sized against the measured wake profile rather than a guess: a cold resume is
 * 18.9s (Daytona) / 24.5s (Platinum) end to end, and each phase of it produces
 * an observable change, so a healthy wake never accumulates more than a few
 * seconds of silence. 75s is comfortably past the slowest legitimate single
 * phase (the server's own provider-confirmation grace is 90s but it emits
 * `runtime_waking` throughout) while still being three times faster to react
 * than the 240s lease that produced the incident.
 */
export const WAKE_NO_PROGRESS_MS = 75_000;

/**
 * Automatic restarts the ladder may perform. Two, because the human fix that
 * always works is one restart, and a second covers the case where the first
 * landed during the same ops event (an image rebuild) that wedged the wake.
 * Unbounded retries would be a restart loop against a genuinely dead provider.
 */
export const WAKE_MAX_RESTARTS = 2;

/**
 * Minimum gap between two ladder actions.
 *
 * A server-declared wake failure short-circuits the no-progress window (there is
 * nothing left to wait for), so without a floor the ladder would spend its whole
 * budget inside one second. `POST /restart` plus its first `/start` take ~2.6s
 * measured; 20s leaves the new attempt room to produce its first signal.
 */
export const WAKE_ESCALATION_COOLDOWN_MS = 20_000;

/** One rung of the ladder. */
export type WakeEscalationStep = 'retry-start' | 'restart';

/** The action to dispatch on THIS tick — `none` on almost every tick. */
export type WakeEscalationDispatch = 'none' | WakeEscalationStep;

export type WakeEscalationStatus =
  /** No wake in progress, or the runtime already answered. */
  | 'idle'
  /** A wake is running and has not needed help. */
  | 'waking'
  /** The ladder has intervened at least once and the wake continues. */
  | 'escalating'
  /** Every rung has been used; the host may now show a terminal card. */
  | 'exhausted';

export interface WakeAttempt {
  step: WakeEscalationStep;
  atMs: number;
}

export interface WakeEscalationState {
  status: WakeEscalationStatus;
  /** What the host must do NOW. Read once per transition, never replayed. */
  dispatch: WakeEscalationDispatch;
  /** The last progress fingerprint seen, or null before the first observation. */
  fingerprint: string | null;
  /** When the fingerprint last changed. */
  lastProgressAtMs: number | null;
  /** When the ladder last dispatched an action. */
  lastDispatchAtMs: number | null;
  /** Everything the ladder has tried, oldest first. */
  attempts: readonly WakeAttempt[];
  /**
   * How long the wake has shown no observable change. This is the
   * PROGRESS-AWARE budget a host should render against — never wall-clock time
   * since the wake began, which is what produced the premature terminal card.
   */
  msSinceProgress: number;
  /** The runtime has answered at least once in this session view. */
  settled: boolean;
}

export interface WakeObservation {
  nowMs: number;
  /**
   * The host is trying to bring this session's runtime up. False switches the
   * ladder off entirely (no session, gated, unmounted) and resets it.
   */
  waking: boolean;
  /**
   * The RUNTIME answered — daemon health, not the session row. True ends the
   * wake and latches: see the module comment.
   */
  runtimeReachable: boolean;
  /**
   * Everything observable about this wake, joined into one value. Any change is
   * progress. Build it with {@link wakeProgressFingerprint}.
   */
  progress: string;
  /**
   * The server has declared this wake failed — the state that used to paint the
   * terminal card. Escalates immediately: there is no further progress to wait
   * for, only a rung of the ladder left to try.
   */
  serverGaveUp: boolean;
}

export interface WakeEscalationLimits {
  noProgressMs?: number;
  maxRestarts?: number;
  cooldownMs?: number;
}

export function initialWakeEscalationState(): WakeEscalationState {
  return {
    status: 'idle',
    dispatch: 'none',
    fingerprint: null,
    lastProgressAtMs: null,
    lastDispatchAtMs: null,
    attempts: [],
    msSinceProgress: 0,
    settled: false,
  };
}

/**
 * Join the observable wake signals into one comparable value, dropping the ones
 * that are not known yet.
 *
 * `null`/`undefined` are DROPPED rather than stringified so that a signal
 * arriving for the first time (a sandbox row appearing, a health body parsing)
 * reads as the progress it is, while a signal that is simply absent contributes
 * nothing and cannot manufacture a change on its own.
 */
export function wakeProgressFingerprint(
  parts: readonly (string | number | boolean | null | undefined)[],
): string {
  return parts.filter((part) => part !== null && part !== undefined).join('|');
}

/** The next rung, or null when the ladder is spent. */
function nextStep(
  attempts: readonly WakeAttempt[],
  maxRestarts: number,
): WakeEscalationStep | null {
  if (attempts.length === 0) return 'retry-start';
  const restarts = attempts.filter((attempt) => attempt.step === 'restart').length;
  return restarts < maxRestarts ? 'restart' : null;
}

/**
 * Fold one observation into the ladder's state. Pure — same inputs, same output,
 * no clock and no I/O.
 */
export function advanceWakeEscalation(
  state: WakeEscalationState,
  observation: WakeObservation,
  limits: WakeEscalationLimits = {},
): WakeEscalationState {
  const noProgressMs = limits.noProgressMs ?? WAKE_NO_PROGRESS_MS;
  const maxRestarts = limits.maxRestarts ?? WAKE_MAX_RESTARTS;
  const cooldownMs = limits.cooldownMs ?? WAKE_ESCALATION_COOLDOWN_MS;

  // The runtime answered. The wake is over, and nothing about it may leak into
  // the next one. `settled` survives the reset: within one session view, a
  // runtime that has answered is never woken again by this machine.
  if (observation.runtimeReachable) {
    return { ...initialWakeEscalationState(), settled: true };
  }
  // The host cannot classify the wake right now — PAUSE, do not forget.
  //
  // This is not hypothetical tidiness. `useRestartProjectSession` seeds the
  // `/start` cache with `{stage: 'provisioning', sandbox: null}` the instant a
  // restart is dispatched, and a null sandbox is exactly "cannot classify". If
  // that cleared `attempts`, every rung the ladder fired would reset its own
  // budget and `WAKE_MAX_RESTARTS` would bound nothing — a restart loop, which
  // is strictly worse than the dead-end card this replaces.
  //
  // The silence clock IS cleared, so resuming re-baselines rather than
  // escalating on the strength of a window the ladder never actually watched.
  // The dispatch cooldown is deliberately kept: a pause must not become a way
  // to fire two rungs back to back.
  if (!observation.waking) {
    return { ...state, dispatch: 'none', fingerprint: null, lastProgressAtMs: null, msSinceProgress: 0 };
  }
  // A runtime that already answered and later dropped is a mid-session
  // reconnect, not a wake. Restarting it would destroy the live turn.
  if (state.settled) return { ...initialWakeEscalationState(), settled: true };

  const previousProgressAtMs = state.lastProgressAtMs;
  const first = previousProgressAtMs === null;
  const changed = observation.progress !== state.fingerprint;
  const lastProgressAtMs =
    previousProgressAtMs === null || changed ? observation.nowMs : previousProgressAtMs;
  const msSinceProgress = Math.max(0, observation.nowMs - lastProgressAtMs);
  const base: WakeEscalationState = {
    ...state,
    dispatch: 'none',
    fingerprint: observation.progress,
    lastProgressAtMs,
    msSinceProgress,
    status: state.attempts.length > 0 ? 'escalating' : 'waking',
  };

  if (state.status === 'exhausted') return { ...base, status: 'exhausted' };

  // A server-declared failure needs no window: the wake is over, only the
  // ladder is left. Everything else waits out the silence.
  const stalled = !first && !changed && msSinceProgress >= noProgressMs;
  if (!observation.serverGaveUp && !stalled) return base;

  // One action per cooldown, whatever triggered it.
  if (
    state.lastDispatchAtMs !== null &&
    observation.nowMs - state.lastDispatchAtMs < cooldownMs
  ) {
    return base;
  }

  const step = nextStep(state.attempts, maxRestarts);
  if (!step) return { ...base, status: 'exhausted' };

  return {
    ...base,
    status: 'escalating',
    dispatch: step,
    attempts: [...state.attempts, { step, atMs: observation.nowMs }],
    lastDispatchAtMs: observation.nowMs,
    // The new attempt gets its own window: it has not been silent yet.
    lastProgressAtMs: observation.nowMs,
    msSinceProgress: 0,
  };
}

const STEP_VERB: Record<WakeEscalationStep, string> = {
  'retry-start': 'retrying',
  restart: 'restarting',
};

/**
 * The honest one-line status while the ladder is working, in the same voice as
 * the boot-phase pill ("Waking the agent", "Connecting").
 *
 * Null while the first, ordinary wake is running — that wake already has honest
 * copy and does not need a second component talking over it — and null once
 * exhausted, where the terminal card takes over.
 */
export function wakeEscalationNote(state: WakeEscalationState): string | null {
  if (state.status !== 'escalating') return null;
  const last = state.attempts[state.attempts.length - 1];
  if (!last) return null;
  // The original wake is attempt 1, so the Nth ladder action is attempt N+1.
  return `Still waking — ${STEP_VERB[last.step]} the runtime (attempt ${state.attempts.length + 1})`;
}

function countWord(count: number): string {
  if (count === 1) return 'once';
  if (count === 2) return 'twice';
  return `${count} times`;
}

/**
 * What the ladder tried, for the terminal card. A dead end that cannot say what
 * was already attempted invites the user to repeat it by hand.
 */
export function wakeEscalationAttemptSummary(state: WakeEscalationState): string | null {
  if (state.status !== 'exhausted') return null;
  const restarts = state.attempts.filter((attempt) => attempt.step === 'restart').length;
  const retried = state.attempts.some((attempt) => attempt.step === 'retry-start');
  if (!retried && restarts === 0) return null;
  const parts: string[] = [];
  if (retried) parts.push('re-issuing the wake');
  if (restarts > 0) parts.push(`restarting the session ${countWord(restarts)}`);
  return `Tried: ${parts.join(', then ')}.`;
}
