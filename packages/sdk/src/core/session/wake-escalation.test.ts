import { describe, expect, it } from 'bun:test';

import {
  advanceWakeEscalation,
  initialWakeEscalationState,
  WAKE_ESCALATION_COOLDOWN_MS,
  WAKE_MAX_RESTARTS,
  WAKE_NO_PROGRESS_MS,
  wakeEscalationAttemptSummary,
  wakeEscalationNote,
  wakeProgressFingerprint,
  type WakeEscalationLimits,
  type WakeEscalationState,
  type WakeObservation,
} from './wake-escalation';

/** Feed one observation and return the next state. */
function step(
  state: WakeEscalationState,
  obs: Partial<WakeObservation> & { nowMs: number },
  limits?: WakeEscalationLimits,
): WakeEscalationState {
  return advanceWakeEscalation(
    state,
    { waking: true, runtimeReachable: false, progress: 'p0', serverGaveUp: false, ...obs },
    limits,
  );
}

describe('wakeProgressFingerprint', () => {
  it('joins the observable wake signals and drops the unknown ones', () => {
    expect(wakeProgressFingerprint(['starting', null, 'stopped', undefined, false, 3])).toBe(
      'starting|stopped|false|3',
    );
  });

  it('is stable for identical input and different for any change', () => {
    const a = wakeProgressFingerprint(['starting', 'runtime_waking', 'stopped']);
    const b = wakeProgressFingerprint(['starting', 'runtime_waking', 'stopped']);
    const c = wakeProgressFingerprint(['starting', 'runtime_waking', 'active']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('advanceWakeEscalation — progress keeps the wake alive', () => {
  it('starts idle with nothing attempted', () => {
    const state = initialWakeEscalationState();
    expect(state.status).toBe('idle');
    expect(state.dispatch).toBe('none');
    expect(state.attempts).toEqual([]);
  });

  it('NEVER escalates while the wake keeps showing progress, however long it takes', () => {
    let state = initialWakeEscalationState();
    // 10 minutes of a slow-but-advancing wake: one observable change every 30s.
    for (let i = 0; i < 20; i += 1) {
      state = step(state, { nowMs: i * 30_000, progress: `phase-${i}` });
      expect(state.dispatch).toBe('none');
    }
    expect(state.attempts).toEqual([]);
    expect(state.status).toBe('waking');
  });

  it('a fast warm resume finishes before any window and never escalates', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'starting' });
    state = step(state, { nowMs: 1_900, progress: 'ready' });
    state = step(state, { nowMs: 2_100, runtimeReachable: true, progress: 'ready' });
    expect(state.status).toBe('idle');
    expect(state.attempts).toEqual([]);
    expect(state.dispatch).toBe('none');
  });

  it('reports how long the wake has shown no change, for the host budget', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 1_000, progress: 'starting' });
    state = step(state, { nowMs: 41_000, progress: 'starting' });
    expect(state.msSinceProgress).toBe(40_000);
    state = step(state, { nowMs: 42_000, progress: 'booting' });
    expect(state.msSinceProgress).toBe(0);
  });
});

describe('advanceWakeEscalation — the ladder', () => {
  it('a silent no-progress window escalates to a quiet /start retry, exactly once', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'stuck' });
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS - 1, progress: 'stuck' });
    expect(state.dispatch).toBe('none');

    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS, progress: 'stuck' });
    expect(state.dispatch).toBe('retry-start');
    expect(state.attempts.map((a) => a.step)).toEqual(['retry-start']);

    // The very next tick must not fire it again.
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS + 1, progress: 'stuck' });
    expect(state.dispatch).toBe('none');
    expect(state.attempts).toHaveLength(1);
  });

  it('escalates retry -> restart -> restart -> exhausted, and no further', () => {
    let state = initialWakeEscalationState();
    let now = 0;
    state = step(state, { nowMs: now, progress: 'stuck' });

    const dispatched: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      now += WAKE_NO_PROGRESS_MS;
      state = step(state, { nowMs: now, progress: 'stuck' });
      dispatched.push(state.dispatch);
    }
    expect(dispatched).toEqual(['retry-start', 'restart', 'restart', 'none']);
    expect(state.status).toBe('exhausted');
    expect(state.attempts.filter((a) => a.step === 'restart')).toHaveLength(WAKE_MAX_RESTARTS);

    // Exhausted is a fixed point while the wake is still going.
    now += WAKE_NO_PROGRESS_MS;
    state = step(state, { nowMs: now, progress: 'stuck' });
    expect(state.dispatch).toBe('none');
    expect(state.status).toBe('exhausted');
    expect(state.attempts).toHaveLength(1 + WAKE_MAX_RESTARTS);
  });

  it('progress after an escalation resets the window instead of escalating again', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'stuck' });
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS, progress: 'stuck' });
    expect(state.dispatch).toBe('retry-start');

    // The retry woke the box: signals start moving again.
    for (let i = 1; i <= 5; i += 1) {
      state = step(state, { nowMs: WAKE_NO_PROGRESS_MS + i * 20_000, progress: `moving-${i}` });
      expect(state.dispatch).toBe('none');
    }
    expect(state.attempts).toHaveLength(1);
    // Still `escalating`, not back to `waking`: the ladder HAS intervened, and
    // the note that says so must stay up while the retried wake runs.
    expect(state.status).toBe('escalating');
    expect(wakeEscalationNote(state)).toBe('Still waking — retrying the runtime (attempt 2)');
  });

  it('a reachable runtime clears the ladder so the next wake starts fresh', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'stuck' });
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS, progress: 'stuck' });
    expect(state.attempts).toHaveLength(1);

    state = step(state, {
      nowMs: WAKE_NO_PROGRESS_MS + 5_000,
      runtimeReachable: true,
      progress: 'ready',
    });
    expect(state.status).toBe('idle');
    expect(state.attempts).toEqual([]);
  });

  it('a host that switches the ladder off PAUSES it — it must not forget what it tried', () => {
    // `useRestartProjectSession` seeds the `/start` cache with
    // `{stage:'provisioning', sandbox:null}` the instant a restart is
    // dispatched, and a null sandbox means the host can no longer classify the
    // wake. If that cleared the ladder, the attempt count would reset on every
    // rung it fires and the "bounded restarts" guarantee would become an
    // unbounded restart loop.
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'stuck' });
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS, progress: 'stuck' });
    expect(state.attempts).toHaveLength(1);

    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS + 1_000, waking: false });
    expect(state.dispatch).toBe('none');
    expect(state.attempts).toHaveLength(1);
    expect(state.settled).toBe(false);
  });

  it('a pause re-baselines the silence clock instead of escalating on resume', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'stuck' });
    state = step(state, { nowMs: 1_000, waking: false });
    // Long gone by wall clock, but the ladder never saw a silent window.
    state = step(state, { nowMs: 10 * WAKE_NO_PROGRESS_MS, progress: 'stuck' });
    expect(state.dispatch).toBe('none');
    expect(state.msSinceProgress).toBe(0);
  });

  it('a restart cycle cannot loop: the ladder still exhausts across the pauses', () => {
    // The real sequence: escalate -> host seeds `sandbox:null` (pause) -> the
    // restart's `/start` answers wake-failed again -> escalate again.
    let state = initialWakeEscalationState();
    let now = 0;
    const dispatched: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      state = step(state, { nowMs: now, progress: 'wake-failed', serverGaveUp: true });
      if (state.dispatch !== 'none') dispatched.push(state.dispatch);
      // The host's optimistic restart seed, one tick later.
      now += 1_000;
      state = step(state, { nowMs: now, waking: false });
      now += WAKE_ESCALATION_COOLDOWN_MS;
    }
    expect(dispatched).toEqual(['retry-start', 'restart', 'restart']);
    expect(state.attempts).toHaveLength(1 + WAKE_MAX_RESTARTS);
  });

  it('honours caller-supplied limits', () => {
    let state = initialWakeEscalationState();
    const limits = { noProgressMs: 10_000, maxRestarts: 1, cooldownMs: 1_000 };
    state = step(state, { nowMs: 0, progress: 'stuck' }, limits);
    state = step(state, { nowMs: 10_000, progress: 'stuck' }, limits);
    expect(state.dispatch).toBe('retry-start');
    state = step(state, { nowMs: 20_000, progress: 'stuck' }, limits);
    expect(state.dispatch).toBe('restart');
    state = step(state, { nowMs: 30_000, progress: 'stuck' }, limits);
    expect(state.status).toBe('exhausted');
  });
});

describe('advanceWakeEscalation — provider truth outranks the session row', () => {
  it('escalates a `ready` session whose runtime never answers (row running, box stopped)', () => {
    // The Essentia desync: POST /start answered 202 and the row says `running`,
    // but the E2B resume silently failed and the daemon proxy 503s. Nothing in
    // the /start payload changes again, so only the health truth can catch it.
    let state = initialWakeEscalationState();
    const readyButDead = wakeProgressFingerprint(['ready', 'active', 'unreachable', false]);
    state = step(state, { nowMs: 0, progress: readyButDead, runtimeReachable: false });
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS, progress: readyButDead });
    expect(state.dispatch).toBe('retry-start');
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS * 2, progress: readyButDead });
    expect(state.dispatch).toBe('restart');
  });

  it('never escalates a runtime that already answered, even if it later drops', () => {
    // Mid-session unreachability is `useRuntimeReconnect`'s job, not the wake
    // ladder's: restarting a box the user is working in would destroy the turn.
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'ready', runtimeReachable: true });
    expect(state.status).toBe('idle');

    let now = 0;
    for (let i = 0; i < 5; i += 1) {
      now += WAKE_NO_PROGRESS_MS;
      state = step(state, { nowMs: now, progress: 'dropped', runtimeReachable: false });
      expect(state.dispatch).toBe('none');
    }
    expect(state.attempts).toEqual([]);
    expect(state.status).toBe('idle');
  });
});

describe('advanceWakeEscalation — a server-declared wake failure', () => {
  it('escalates at once instead of waiting out the no-progress window', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'starting' });
    state = step(state, { nowMs: 1_000, progress: 'wake-failed', serverGaveUp: true });
    expect(state.dispatch).toBe('retry-start');
    expect(state.status).toBe('escalating');
  });

  it('never machine-guns the ladder: a repeated verdict waits out the cooldown', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'wake-failed', serverGaveUp: true });
    expect(state.dispatch).toBe('retry-start');

    state = step(state, { nowMs: 500, progress: 'wake-failed', serverGaveUp: true });
    expect(state.dispatch).toBe('none');
    state = step(state, {
      nowMs: WAKE_ESCALATION_COOLDOWN_MS - 1,
      progress: 'wake-failed',
      serverGaveUp: true,
    });
    expect(state.dispatch).toBe('none');

    state = step(state, {
      nowMs: WAKE_ESCALATION_COOLDOWN_MS,
      progress: 'wake-failed',
      serverGaveUp: true,
    });
    expect(state.dispatch).toBe('restart');
  });

  it('still stops at the bounded restart count', () => {
    let state = initialWakeEscalationState();
    let now = 0;
    const dispatched: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      state = step(state, { nowMs: now, progress: 'wake-failed', serverGaveUp: true });
      if (state.dispatch !== 'none') dispatched.push(state.dispatch);
      now += WAKE_ESCALATION_COOLDOWN_MS;
    }
    expect(dispatched).toEqual(['retry-start', 'restart', 'restart']);
    expect(state.status).toBe('exhausted');
  });
});

describe('escalation copy', () => {
  it('says nothing while the first, ordinary wake is still running', () => {
    const state = step(initialWakeEscalationState(), { nowMs: 0, progress: 'starting' });
    expect(wakeEscalationNote(state)).toBeNull();
    expect(wakeEscalationAttemptSummary(state)).toBeNull();
  });

  it('names the attempt while escalating', () => {
    let state = initialWakeEscalationState();
    state = step(state, { nowMs: 0, progress: 'stuck' });
    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS, progress: 'stuck' });
    expect(wakeEscalationNote(state)).toBe('Still waking — retrying the runtime (attempt 2)');

    state = step(state, { nowMs: WAKE_NO_PROGRESS_MS * 2, progress: 'stuck' });
    expect(wakeEscalationNote(state)).toBe('Still waking — restarting the runtime (attempt 3)');
  });

  it('the exhausted summary names everything that was tried', () => {
    let state = initialWakeEscalationState();
    let now = 0;
    // The first observation can never be stale — it establishes the baseline.
    state = step(state, { nowMs: now, progress: 'stuck' });
    for (let i = 0; i < 4; i += 1) {
      now += WAKE_NO_PROGRESS_MS;
      state = step(state, { nowMs: now, progress: 'stuck' });
    }
    expect(state.status).toBe('exhausted');
    expect(wakeEscalationAttemptSummary(state)).toBe(
      'Tried: re-issuing the wake, then restarting the session twice.',
    );
    expect(wakeEscalationNote(state)).toBeNull();
  });

  it('summarises a single restart in the singular', () => {
    let state = initialWakeEscalationState();
    const limits = { noProgressMs: 10_000, maxRestarts: 1, cooldownMs: 1_000 };
    let now = 0;
    state = step(state, { nowMs: now, progress: 'stuck' }, limits);
    for (let i = 0; i < 3; i += 1) {
      now += 10_000;
      state = step(state, { nowMs: now, progress: 'stuck' }, limits);
    }
    expect(state.status).toBe('exhausted');
    expect(wakeEscalationAttemptSummary(state)).toBe(
      'Tried: re-issuing the wake, then restarting the session once.',
    );
  });
});
