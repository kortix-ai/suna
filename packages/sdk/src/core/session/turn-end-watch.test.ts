import { describe, expect, test } from 'bun:test';
import type { SessionTurnStatus } from '../rest/projects-client/sessions';
import {
  TURN_END_WATCH_FIRST_READ_MS,
  TURN_END_WATCH_LONG_TURN_MS,
  TURN_END_WATCH_MAX_MS,
  TURN_END_WATCH_POLL_MS,
  TURN_END_WATCH_SLOW_POLL_MS,
  TURN_END_WATCH_START_MS,
  type TurnEndHandoff,
  type TurnEndOutcome,
  createTurnEndWatch,
  readTurnEnd,
} from './turn-end-watch';

const OPEN: SessionTurnStatus = {
  turns: [
    {
      turn_token: 'T1',
      state: 'active',
      message_id: 'm1',
      opencode_session_id: 'oc1',
      started_at: '2026-10-16T09:00:00.000Z',
      accepted_at: '2026-10-16T09:00:01.000Z',
    },
  ],
  last_ended: { turn_token: 'T0', end_reason: 'completed', ended_at: '2026-10-16T08:00:00.000Z' },
};

function ended(
  last: NonNullable<SessionTurnStatus['last_ended']>,
  extra: Partial<SessionTurnStatus> = {},
): SessionTurnStatus {
  return { turns: [], last_ended: last, ...extra };
}

const COMPLETED_T1 = ended({
  turn_token: 'T1',
  message_id: 'm1',
  end_reason: 'completed',
  ended_at: '2026-10-16T09:05:00.000Z',
});

function handoff(overrides: Partial<TurnEndHandoff> = {}): TurnEndHandoff {
  return {
    projectId: 'P1',
    sessionId: 'S1',
    openTurnToken: 'T1',
    lastEndedToken: 'T0',
    ...overrides,
  };
}

describe('readTurnEnd: what one /turn read says about the turn the page left running', () => {
  test('a turn still open is running', () => {
    expect(readTurnEnd(handoff(), OPEN, false)).toEqual({ state: 'running' });
  });

  test('the turn the page left open is gone: it ended, and how comes from last_ended', () => {
    expect(readTurnEnd(handoff(), COMPLETED_T1, false)).toEqual({
      state: 'ended',
      outcome: { kind: 'completed' },
    });
  });

  test('no open token at hand-off (a send still in flight): a NEW last_ended is the end', () => {
    expect(readTurnEnd(handoff({ openTurnToken: null }), COMPLETED_T1, false)).toEqual({
      state: 'ended',
      outcome: { kind: 'completed' },
    });
  });

  test('no open token and the same last_ended the page knew: the turn has not started yet', () => {
    // The page's send receipt said "working" before the server minted the
    // turn. Reading this as an end would announce the PREVIOUS turn again.
    const before = ended({ turn_token: 'T0', end_reason: 'completed', ended_at: null });
    expect(readTurnEnd(handoff({ openTurnToken: null }), before, false)).toEqual({ state: 'waiting' });
  });

  test('an open turn seen by an earlier read, then idle: it ended even with no last_ended row', () => {
    expect(readTurnEnd(handoff({ openTurnToken: null }), { turns: [] }, true)).toEqual({
      state: 'ended',
      outcome: { kind: 'completed' },
    });
  });

  test('a failure with a named cause is a failure, carrying that cause', () => {
    const read = ended({
      turn_token: 'T1',
      message_id: 'm1',
      end_reason: 'failed',
      ended_at: null,
      error: { name: 'APIError', message: 'The model provider rejected the request.' },
    });
    expect(readTurnEnd(handoff(), read, false)).toEqual({
      state: 'ended',
      outcome: {
        kind: 'failed',
        error: { name: 'APIError', message: 'The model provider rejected the request.' },
      },
    });
  });

  test('a failed turn nobody explained is listed in recent_failures: still a failure', () => {
    const read = ended(
      { turn_token: 'T1', message_id: 'm1', end_reason: 'failed', ended_at: null },
      { recent_failures: [{ message_id: 'm1', ended_at: null, error: null }] },
    );
    expect(readTurnEnd(handoff(), read, false)).toEqual({
      state: 'ended',
      outcome: { kind: 'failed', error: null },
    });
  });

  test('a failed turn with no error and no recent_failures row is a requested stop: silent', () => {
    // The API strips UserStop / QueueInterrupt from last_ended.error and never
    // lists them as failures: someone asked for this stop.
    const read = ended({ turn_token: 'T1', message_id: 'm1', end_reason: 'failed', ended_at: null });
    expect(readTurnEnd(handoff(), read, false)).toEqual({
      state: 'ended',
      outcome: { kind: 'stopped' },
    });
  });

  test('an abort is the effect of a stop, not a failure: silent', () => {
    const read = ended({
      turn_token: 'T1',
      end_reason: 'failed',
      ended_at: null,
      error: { name: 'MessageAbortedError', message: 'Aborted' },
    });
    expect(readTurnEnd(handoff(), read, false)).toEqual({
      state: 'ended',
      outcome: { kind: 'stopped' },
    });
  });

  test('the box going away mid-turn is a failure', () => {
    const read = ended({ turn_token: 'T1', end_reason: 'runtime_gone', ended_at: null });
    expect(readTurnEnd(handoff(), read, false)).toEqual({
      state: 'ended',
      outcome: { kind: 'failed', error: null },
    });
  });

  test('a turn that is provably over with no known cause (`unknown`) reads as finished', () => {
    const read = ended({ turn_token: 'T1', end_reason: 'unknown', ended_at: null });
    expect(readTurnEnd(handoff(), read, false)).toEqual({
      state: 'ended',
      outcome: { kind: 'completed' },
    });
  });
});

/** A clock whose timers run only when the test advances it. */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    pending: () => timers.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        // Let the read's promise chain settle before the next timer.
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      now = until;
    },
  };
}

function harness(reads: Array<SessionTurnStatus | Error | (() => Promise<SessionTurnStatus>)>) {
  const clock = fakeClock();
  const calls: string[] = [];
  const ends: Array<{ handoff: TurnEndHandoff; outcome: TurnEndOutcome }> = [];
  const queue = [...reads];
  const watch = createTurnEndWatch({
    readTurn: async (projectId, sessionId) => {
      calls.push(`${projectId}/${sessionId}`);
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next;
    },
    onEnded: (h, outcome) => ends.push({ handoff: h, outcome }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, calls, ends, watch };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('createTurnEndWatch: a turn left running by a page that unmounted', () => {
  test('announces the end exactly once, then stops reading', async () => {
    // The KRTX-2520 repro: start a turn, navigate to the project home, the turn
    // ends. The session page (and its stream) is gone; nothing else knew.
    const { clock, calls, ends, watch } = harness([OPEN, OPEN, COMPLETED_T1]);
    watch.watch(handoff());

    await clock.advance(TURN_END_WATCH_FIRST_READ_MS);
    expect(calls).toHaveLength(1);
    expect(ends).toHaveLength(0);

    await clock.advance(TURN_END_WATCH_POLL_MS * 2);
    expect(calls).toHaveLength(3);
    expect(ends).toEqual([{ handoff: handoff(), outcome: { kind: 'completed' } }]);

    await clock.advance(TURN_END_WATCH_POLL_MS * 10);
    expect(calls).toHaveLength(3);
    expect(clock.pending()).toBe(0);
    expect(watch.watching()).toEqual([]);
  });

  test('the page coming back reclaims the session: the watch never reads or announces', async () => {
    // The mounted page's own stream announces the end; a second announcement
    // from here would be the double notification.
    const { clock, calls, ends, watch } = harness([COMPLETED_T1]);
    watch.watch(handoff());
    watch.release('P1', 'S1');
    await clock.advance(TURN_END_WATCH_POLL_MS * 4);
    expect(calls).toHaveLength(0);
    expect(ends).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  test('a read in flight when the page comes back is dropped', async () => {
    let resolveRead: (value: SessionTurnStatus) => void = () => {};
    const { clock, ends, watch } = harness([
      () => new Promise<SessionTurnStatus>((resolve) => (resolveRead = resolve)),
    ]);
    watch.watch(handoff());
    await clock.advance(TURN_END_WATCH_FIRST_READ_MS);
    watch.release('P1', 'S1');
    resolveRead(COMPLETED_T1);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(ends).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  test('a second hand-off of the same session replaces the first: one cadence, one announcement', async () => {
    const { clock, calls, ends, watch } = harness([OPEN, COMPLETED_T1]);
    watch.watch(handoff());
    watch.watch(handoff({ title: () => 'Renamed' }));
    expect(clock.pending()).toBe(1);
    await clock.advance(TURN_END_WATCH_FIRST_READ_MS + TURN_END_WATCH_POLL_MS);
    expect(calls).toHaveLength(2);
    expect(ends).toHaveLength(1);
    expect(ends[0].handoff.title?.()).toBe('Renamed');
  });

  test('a failed read is retried on the next tick; the end still lands', async () => {
    const { clock, ends, watch } = harness([httpError(503), new TypeError('fetch failed'), COMPLETED_T1]);
    watch.watch(handoff());
    await clock.advance(TURN_END_WATCH_FIRST_READ_MS + TURN_END_WATCH_POLL_MS * 2);
    expect(ends).toEqual([{ handoff: handoff(), outcome: { kind: 'completed' } }]);
  });

  test('a session that is gone or no longer readable (404 / 403) ends the watch silently', async () => {
    for (const status of [403, 404]) {
      const { clock, calls, ends, watch } = harness([httpError(status)]);
      watch.watch(handoff());
      await clock.advance(TURN_END_WATCH_FIRST_READ_MS + TURN_END_WATCH_POLL_MS * 4);
      expect(calls).toHaveLength(1);
      expect(ends).toHaveLength(0);
      expect(watch.watching()).toEqual([]);
    }
  });

  test('a turn that never starts stops being waited for after the start window', async () => {
    const before = ended({ turn_token: 'T0', end_reason: 'completed', ended_at: null });
    const { clock, calls, ends, watch } = harness([before]);
    watch.watch(handoff({ openTurnToken: null }));
    await clock.advance(TURN_END_WATCH_START_MS + TURN_END_WATCH_POLL_MS);
    const readsInWindow = calls.length;
    await clock.advance(TURN_END_WATCH_POLL_MS * 4);
    expect(calls).toHaveLength(readsInWindow);
    expect(ends).toHaveLength(0);
    expect(watch.watching()).toEqual([]);
  });

  test('a long turn is read less often, and the watch gives up after its ceiling', async () => {
    const { clock, calls, ends, watch } = harness([OPEN]);
    watch.watch(handoff());
    await clock.advance(TURN_END_WATCH_LONG_TURN_MS);
    const fast = calls.length;
    await clock.advance(TURN_END_WATCH_SLOW_POLL_MS * 4);
    // Four more reads in four slow periods, not twelve at the fast cadence.
    expect(calls.length - fast).toBe(4);
    await clock.advance(TURN_END_WATCH_MAX_MS);
    const atCeiling = calls.length;
    await clock.advance(TURN_END_WATCH_SLOW_POLL_MS * 4);
    expect(calls).toHaveLength(atCeiling);
    expect(ends).toHaveLength(0);
    expect(watch.watching()).toEqual([]);
  });

  test('two sessions are watched and announced independently', async () => {
    const reads = new Map<string, SessionTurnStatus[]>([
      ['P1/S1', [OPEN, COMPLETED_T1]],
      ['P1/S2', [OPEN, OPEN, OPEN, COMPLETED_T1]],
    ]);
    const clock = fakeClock();
    const ends: string[] = [];
    const watch = createTurnEndWatch({
      readTurn: async (projectId, sessionId) => {
        const list = reads.get(`${projectId}/${sessionId}`)!;
        return list.length > 1 ? list.shift()! : list[0];
      },
      onEnded: (h) => ends.push(h.sessionId),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    watch.watch(handoff());
    watch.watch(handoff({ sessionId: 'S2' }));
    await clock.advance(TURN_END_WATCH_FIRST_READ_MS + TURN_END_WATCH_POLL_MS);
    expect(ends).toEqual(['S1']);
    expect(watch.watching()).toEqual(['P1/S2']);
    await clock.advance(TURN_END_WATCH_POLL_MS * 2);
    expect(ends).toEqual(['S1', 'S2']);
  });
});
