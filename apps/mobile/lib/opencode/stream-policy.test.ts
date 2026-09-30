import { describe, expect, test } from 'bun:test';
import {
  statusesToHydrate,
  unlistedWorkingSessions,
  transcriptEndsFinished,
  HEARTBEAT_TIMEOUT_MS,
  HOLLOW_STREAM_END_MS,
  MAX_HARD_FAILURES,
  PARKED_RETRY_MS,
  STREAM_STABLE_MS,
  TOKEN_TIMEOUT_MS,
  REHYDRATE_GAP_MS,
  SSE_KEEPALIVE_INTERVAL_MS,
  STREAM_RECYCLE_BYTES,
  isFullSession,
  isHollowStreamEnd,
  isLivenessOnlyEvent,
  isStreamStable,
  nextReconnectDelay,
  nextRetry,
  onForeground,
  patchSessionList,
  questionsToHydrate,
  shouldPark,
  shouldReconcileOnOpen,
  shouldRecycleStream,
} from './stream-policy';

describe('heartbeat watchdog', () => {
  test('outlasts two daemon keepalive intervals', () => {
    // The daemon writes a keepalive after >= 20 s of silence, checked every
    // 20 s, so a healthy quiet stream can be silent for up to 40 s.
    expect(SSE_KEEPALIVE_INTERVAL_MS).toBe(20_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(60_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBeGreaterThan(SSE_KEEPALIVE_INTERVAL_MS * 2);
  });
});

describe('shouldRecycleStream', () => {
  test('budget is 2 MB', () => {
    expect(STREAM_RECYCLE_BYTES).toBe(2 * 1024 * 1024);
  });

  test('recycles only once the budget is reached', () => {
    expect(shouldRecycleStream(0, STREAM_RECYCLE_BYTES)).toBe(false);
    expect(shouldRecycleStream(STREAM_RECYCLE_BYTES - 1, STREAM_RECYCLE_BYTES)).toBe(false);
    expect(shouldRecycleStream(STREAM_RECYCLE_BYTES, STREAM_RECYCLE_BYTES)).toBe(true);
    expect(shouldRecycleStream(STREAM_RECYCLE_BYTES * 3, STREAM_RECYCLE_BYTES)).toBe(true);
  });
});

describe('onForeground', () => {
  test('an open stream with a recent frame is left alone', () => {
    expect(onForeground({ streamOpen: true, msSinceLastFrame: 1_000 })).toBe('none');
    expect(
      onForeground({ streamOpen: true, msSinceLastFrame: HEARTBEAT_TIMEOUT_MS - 1 }),
    ).toBe('none');
  });

  test('an open stream whose last frame is older than the watchdog reconnects', () => {
    expect(
      onForeground({ streamOpen: true, msSinceLastFrame: HEARTBEAT_TIMEOUT_MS }),
    ).toBe('reconnect');
  });

  test('a closed or parked stream reconnects', () => {
    expect(onForeground({ streamOpen: false, msSinceLastFrame: 10 })).toBe('reconnect');
  });
});

describe('nextReconnectDelay', () => {
  test('is 250 ms doubled per attempt, capped at 30 s, before jitter', () => {
    expect(nextReconnectDelay(0, 0.5)).toBe(250);
    expect(nextReconnectDelay(1, 0.5)).toBe(500);
    expect(nextReconnectDelay(3, 0.5)).toBe(2_000);
    expect(nextReconnectDelay(20, 0.5)).toBe(30_000);
  });

  test('applies +/-20 % jitter from the random source', () => {
    expect(nextReconnectDelay(2, 0)).toBe(800);
    expect(nextReconnectDelay(2, 0.999999)).toBeCloseTo(1_200, 0);
    expect(nextReconnectDelay(20, 0)).toBe(24_000);
    expect(nextReconnectDelay(20, 0.999999)).toBeCloseTo(36_000, 0);
  });
});

describe('shouldPark', () => {
  test('parks after 8 consecutive hard failures', () => {
    expect(MAX_HARD_FAILURES).toBe(8);
    expect(shouldPark(0)).toBe(false);
    expect(shouldPark(7)).toBe(false);
    expect(shouldPark(8)).toBe(true);
    expect(shouldPark(9)).toBe(true);
  });
});

describe('shouldReconcileOnOpen', () => {
  test('the first connection never reconciles', () => {
    expect(shouldReconcileOnOpen({ cause: 'initial', gapMs: 120_000 })).toBe(false);
  });

  test('an interrupted connection reconciles only past the gap threshold', () => {
    expect(shouldReconcileOnOpen({ cause: 'interrupted', gapMs: REHYDRATE_GAP_MS })).toBe(false);
    expect(shouldReconcileOnOpen({ cause: 'interrupted', gapMs: REHYDRATE_GAP_MS + 1 })).toBe(true);
  });

  test('a recycled connection always reconciles: events between close and open are lost', () => {
    expect(shouldReconcileOnOpen({ cause: 'recycle', gapMs: 0 })).toBe(true);
  });
});

describe('nextRetry', () => {
  test('backs off with jitter below the park threshold', () => {
    expect(nextRetry({ attempt: 2, hardFailures: 7, rand: 0.5 })).toEqual({ parked: false, delayMs: 1_000 });
  });

  test('parks at the threshold and probes once per minute', () => {
    expect(PARKED_RETRY_MS).toBe(60_000);
    expect(nextRetry({ attempt: 8, hardFailures: 8, rand: 0.5 })).toEqual({
      parked: true,
      delayMs: PARKED_RETRY_MS,
    });
    expect(nextRetry({ attempt: 30, hardFailures: 12, rand: 0 })).toEqual({
      parked: true,
      delayMs: PARKED_RETRY_MS,
    });
  });
});

describe('isStreamStable', () => {
  test('a stream is stable after 10 s open or its first real event', () => {
    expect(STREAM_STABLE_MS).toBe(10_000);
    expect(isStreamStable({ openForMs: 9_999, sawEvent: false })).toBe(false);
    expect(isStreamStable({ openForMs: 10_000, sawEvent: false })).toBe(true);
    expect(isStreamStable({ openForMs: 5, sawEvent: true })).toBe(true);
  });
});

describe('isLivenessOnlyEvent', () => {
  test('connection, heartbeat, and keepalive frames prove only that the stream is alive', () => {
    expect(isLivenessOnlyEvent('server.connected')).toBe(true);
    expect(isLivenessOnlyEvent('server.heartbeat')).toBe(true);
    expect(isLivenessOnlyEvent('kortix.keepalive')).toBe(true);
  });

  test('every other event type is a real event', () => {
    expect(isLivenessOnlyEvent('message.part.delta')).toBe(false);
    expect(isLivenessOnlyEvent('session.status')).toBe(false);
  });
});

describe('isHollowStreamEnd', () => {
  test('a 2xx stream that ends within 5 s of open with no real event is hollow', () => {
    expect(HOLLOW_STREAM_END_MS).toBe(5_000);
    expect(isHollowStreamEnd({ openForMs: 0, sawEvent: false })).toBe(true);
    expect(isHollowStreamEnd({ openForMs: HOLLOW_STREAM_END_MS - 1, sawEvent: false })).toBe(true);
  });

  test('a stream that delivered a real event, or stayed open 5 s, ended normally', () => {
    expect(isHollowStreamEnd({ openForMs: 50, sawEvent: true })).toBe(false);
    expect(isHollowStreamEnd({ openForMs: HOLLOW_STREAM_END_MS, sawEvent: false })).toBe(false);
  });
});

describe('token timeout', () => {
  test('a token read is bounded at 15 s', () => {
    expect(TOKEN_TIMEOUT_MS).toBe(15_000);
  });
});

function session(id: string, updated: number, title = `title ${id}`) {
  return {
    id,
    slug: id,
    projectID: 'p',
    directory: '/workspace',
    title,
    version: '1',
    time: { created: 1, updated },
  };
}

describe('isFullSession', () => {
  test('a complete session object is full', () => {
    expect(isFullSession(session('s1', 5))).toBe(true);
  });

  test('partial payloads are not full', () => {
    expect(isFullSession({ id: 's1', title: 'x' })).toBe(false);
    expect(isFullSession({ id: 's1', time: { created: 1, updated: 2 } })).toBe(false);
    expect(isFullSession(null)).toBe(false);
  });
});

describe('patchSessionList', () => {
  test('replaces the session in place and keeps most-recent-first order', () => {
    const list = [session('a', 30), session('b', 20), session('c', 10)];
    const next = patchSessionList(list, session('c', 40, 'renamed'));
    expect(next?.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    expect(next?.[0].title).toBe('renamed');
    expect(next?.[1]).toBe(list[0]);
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  test('returns undefined when the session is not in the list', () => {
    expect(patchSessionList([session('a', 1)], session('z', 2))).toBeUndefined();
  });
});

describe('questionsToHydrate', () => {
  const question = (id: string, sessionID: string) => ({ id, sessionID, questions: [] });

  test('adds pending questions of included sessions that the store lacks', () => {
    const fetched = [question('q1', 's1'), question('q2', 's1'), question('q3', 's2'), question('q4', 's3')];
    const existing = { s1: [question('q1', 's1')] };
    const added = questionsToHydrate(fetched, existing, (sessionId) => sessionId !== 's3');
    expect(added.map((entry) => entry.id)).toEqual(['q2', 'q3']);
  });

  test('ignores malformed payloads and duplicates', () => {
    expect(questionsToHydrate({ error: 'x' }, {}, () => true)).toEqual([]);
    const added = questionsToHydrate(
      [question('q1', 's1'), question('q1', 's1'), { id: 5 }, null],
      {},
      () => true,
    );
    expect(added.map((entry) => entry.id)).toEqual(['q1']);
  });
});

// KRTX-606: a thread opened (or a stream reopened) mid-turn read "not
// running" — busy/idle came only from live frames, and nothing re-read it.
describe('statusesToHydrate', () => {
  type Status = { type: 'busy' | 'idle' };
  const busy: Status = { type: 'busy' };
  const all = () => true;

  test('a busy session the store has no status for reads busy', () => {
    expect(statusesToHydrate({ s1: busy }, {}, {}, all)).toEqual([['s1', busy]]);
  });

  // A first prompt is seeded busy before a freshly booted box has put the turn
  // on the wire, and that box answers "not busy". Writing idle from absence
  // would erase the seed: the exact "not running while running" of KRTX-606.
  test('absence from the list never writes idle over a busy slot', () => {
    expect(statusesToHydrate({}, { s1: busy }, { s1: busy }, all)).toEqual([]);
  });

  test('a listed busy session overwrites an idle slot', () => {
    const slot: Status = { type: 'idle' };
    expect(statusesToHydrate({ s1: busy }, { s1: slot }, { s1: slot }, all)).toEqual([['s1', busy]]);
  });

  test('a frame that landed while the read was in flight wins', () => {
    const before: Record<string, Status> = { s1: { type: 'idle' } };
    const current: Record<string, Status> = { s1: { type: 'idle' } };
    expect(statusesToHydrate({ s1: busy }, before, current, all)).toEqual([]);
  });

  test('a session on another computer is left alone', () => {
    expect(statusesToHydrate({}, { s2: busy }, { s2: busy }, (id) => id !== 's2')).toEqual([]);
  });

  test('an unchanged status is not rewritten', () => {
    const slot: Status = { type: 'busy' };
    expect(statusesToHydrate({ s1: busy }, { s1: slot }, { s1: slot }, all)).toEqual([]);
  });

  test('a malformed body writes nothing', () => {
    expect(statusesToHydrate(null, {}, {}, all)).toEqual([]);
    expect(statusesToHydrate([busy], {}, {}, all)).toEqual([]);
  });
});

// A turn that ended while the stream was down: the idle frame is lost and
// `statusesToHydrate` never writes idle from absence. These two name the
// evidence that may.
describe('unlistedWorkingSessions', () => {
  type Status = { type: 'busy' | 'retry' | 'idle' };
  const busy: Status = { type: 'busy' };
  const all = () => true;

  test('a working slot the runtime does not list is a candidate', () => {
    expect(unlistedWorkingSessions({}, { s1: busy }, { s1: busy }, all)).toEqual(['s1']);
  });

  test('a retry slot counts as working', () => {
    const retry: Status = { type: 'retry' };
    expect(unlistedWorkingSessions({}, { s1: retry }, { s1: retry }, all)).toEqual(['s1']);
  });

  test('a listed session is not a candidate', () => {
    expect(unlistedWorkingSessions({ s1: busy }, { s1: busy }, { s1: busy }, all)).toEqual([]);
  });

  test('an idle slot is not a candidate', () => {
    const idle: Status = { type: 'idle' };
    expect(unlistedWorkingSessions({}, { s1: idle }, { s1: idle }, all)).toEqual([]);
  });

  test('a slot that changed while the read was in flight is left alone', () => {
    expect(unlistedWorkingSessions({}, { s1: { type: 'busy' } }, { s1: { type: 'busy' } }, all)).toEqual([]);
  });

  test('a session on another computer is left alone', () => {
    expect(unlistedWorkingSessions({}, { s1: busy }, { s1: busy }, () => false)).toEqual([]);
  });

  test('a malformed body names nothing', () => {
    expect(unlistedWorkingSessions(null, { s1: busy }, { s1: busy }, all)).toEqual([]);
    expect(unlistedWorkingSessions([busy], { s1: busy }, { s1: busy }, all)).toEqual([]);
  });
});

describe('transcriptEndsFinished', () => {
  const user = { info: { role: 'user' } };
  const open = { info: { role: 'assistant', time: { created: 1 } } };
  const completed = { info: { role: 'assistant', time: { created: 1, completed: 2 } } };
  const errored = { info: { role: 'assistant', time: { created: 1 }, error: { name: 'MessageAbortedError' } } };

  test('a completed reply ends the transcript', () => {
    expect(transcriptEndsFinished([user, completed])).toBe(true);
  });

  test('an errored reply ends the transcript', () => {
    expect(transcriptEndsFinished([user, errored])).toBe(true);
  });

  test('an open reply does not', () => {
    expect(transcriptEndsFinished([user, open])).toBe(false);
  });

  // A prompt whose user message is the newest in the store. A send in flight
  // is excluded separately, in `hydrateLiveStatuses`.
  test('a trailing user message does not', () => {
    expect(transcriptEndsFinished([user, completed, user])).toBe(false);
  });

  test('an empty or missing transcript does not', () => {
    expect(transcriptEndsFinished([])).toBe(false);
    expect(transcriptEndsFinished(undefined)).toBe(false);
  });
});
