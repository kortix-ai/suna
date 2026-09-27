import { describe, expect, test } from 'bun:test';
import {
  FLUSH_INTERVAL_MS,
  MAX_QUEUE_SIZE,
  coalesceEvents,
  createEventBatcher,
  type StreamEvent,
} from './event-batcher';

function delta(partID: string, text: string, messageID = 'msg-1', sessionID = 'ses-1'): StreamEvent {
  return {
    type: 'message.part.delta',
    properties: { sessionID, messageID, partID, field: 'text', delta: text },
  };
}

function partUpdated(partID: string, text: string, messageID = 'msg-1'): StreamEvent {
  return {
    type: 'message.part.updated',
    properties: { part: { id: partID, messageID, sessionID: 'ses-1', type: 'text', text } },
  };
}

/** A manual clock: timers fire only when the test advances time. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let dueId: number | undefined;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId === undefined) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

describe('coalesceEvents', () => {
  test('merges deltas for one part across the whole queue', () => {
    const out = coalesceEvents([
      delta('a', 'Hel'),
      delta('b', 'x'),
      delta('a', 'lo'),
      delta('b', 'y'),
    ]);
    expect(out.map((e) => [e.properties.partID, e.properties.delta])).toEqual([
      ['a', 'Hello'],
      ['b', 'xy'],
    ]);
  });

  test('keeps delta -> part.updated -> delta order for the same part', () => {
    const out = coalesceEvents([
      delta('a', 'He'),
      delta('a', 'l'),
      partUpdated('a', 'Hel'),
      delta('a', 'lo'),
      delta('a', '!'),
    ]);
    expect(out.map((e) => [e.type, e.properties.delta ?? e.properties.part?.text])).toEqual([
      ['message.part.delta', 'Hel'],
      ['message.part.updated', 'Hel'],
      ['message.part.delta', 'lo!'],
    ]);
  });

  test('an update for another part does not split a run', () => {
    const out = coalesceEvents([delta('a', '1'), partUpdated('tool-1', ''), delta('a', '2')]);
    expect(out.map((e) => e.type)).toEqual(['message.part.delta', 'message.part.updated']);
    expect(out[0].properties.delta).toBe('12');
  });

  test('session.idle closes the runs of its session', () => {
    const out = coalesceEvents([
      delta('a', '1'),
      { type: 'session.idle', properties: { sessionID: 'ses-1' } },
      delta('a', '2'),
    ]);
    expect(out.map((e) => e.type)).toEqual([
      'message.part.delta',
      'session.idle',
      'message.part.delta',
    ]);
  });

  test('message.updated for a user message closes the runs of its session', () => {
    const out = coalesceEvents([
      delta('a', 'x', 'assistant-1'),
      {
        type: 'message.updated',
        properties: { info: { id: 'user-1', role: 'user', sessionID: 'ses-1' } },
      },
      delta('a', 'y', 'assistant-1'),
    ]);
    expect(out.map((e) => e.type)).toEqual([
      'message.part.delta',
      'message.updated',
      'message.part.delta',
    ]);
    expect(out[0].properties.delta).toBe('x');
    expect(out[2].properties.delta).toBe('y');
  });

  test('message.updated for a user message in another session keeps the run', () => {
    const out = coalesceEvents([
      delta('a', 'x', 'assistant-1'),
      {
        type: 'message.updated',
        properties: { info: { id: 'user-9', role: 'user', sessionID: 'ses-9' } },
      },
      delta('a', 'y', 'assistant-1'),
    ]);
    expect(out.length).toBe(2);
    expect(out[0].properties.delta).toBe('xy');
  });

  test('does not mutate the input events', () => {
    const first = delta('a', 'x');
    coalesceEvents([first, delta('a', 'y')]);
    expect(first.properties.delta).toBe('x');
  });
});

describe('createEventBatcher', () => {
  test('100 deltas within 50 ms produce one flush with one merged delta', () => {
    const timers = fakeTimers();
    const flushes: StreamEvent[][] = [];
    const batcher = createEventBatcher({
      apply: (events) => flushes.push(events),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    for (let i = 0; i < 100; i++) {
      batcher.enqueue(delta('a', String(i % 10)));
      timers.advance(0.5);
    }
    expect(flushes.length).toBe(0);
    timers.advance(FLUSH_INTERVAL_MS);
    expect(flushes.length).toBe(1);
    expect(flushes[0].length).toBe(1);
    expect(flushes[0][0].properties.delta.length).toBe(100);
  });

  test('flushes at most once per interval while events keep arriving', () => {
    const timers = fakeTimers();
    let count = 0;
    const batcher = createEventBatcher({
      apply: () => count++,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    // 1 event per ms for 640 ms.
    for (let i = 0; i < 640; i++) {
      batcher.enqueue(delta('a', 'x'));
      timers.advance(1);
    }
    timers.advance(FLUSH_INTERVAL_MS);
    expect(FLUSH_INTERVAL_MS).toBe(64);
    expect(count).toBeLessThanOrEqual(11);
    expect(count).toBeGreaterThanOrEqual(9);
  });

  test('a status event flushes on the next tick, after the preceding deltas', () => {
    const timers = fakeTimers();
    const flushes: StreamEvent[][] = [];
    const batcher = createEventBatcher({
      apply: (events) => flushes.push(events),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    batcher.enqueue(delta('a', 'Hel'));
    batcher.enqueue(delta('a', 'lo'));
    batcher.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-1' } });
    timers.advance(0);
    expect(flushes.length).toBe(1);
    expect(flushes[0].map((e) => e.type)).toEqual(['message.part.delta', 'session.idle']);
    expect(flushes[0][0].properties.delta).toBe('Hello');
  });

  test.each(['session.status', 'session.error', 'question.asked', 'permission.asked'])(
    '%s is urgent',
    (type) => {
      const timers = fakeTimers();
      let count = 0;
      const batcher = createEventBatcher({
        apply: () => count++,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      });
      batcher.enqueue({ type, properties: { sessionID: 'ses-1' } });
      timers.advance(0);
      expect(count).toBe(1);
    },
  );

  test('a full queue flushes inline', () => {
    const timers = fakeTimers();
    const flushes: StreamEvent[][] = [];
    const batcher = createEventBatcher({
      apply: (events) => flushes.push(events),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) batcher.enqueue(partUpdated(`p${i}`, ''));
    expect(MAX_QUEUE_SIZE).toBe(200);
    expect(flushes.length).toBe(1);
    expect(flushes[0].length).toBe(MAX_QUEUE_SIZE);
    expect(timers.pending()).toBe(0);
  });

  test('flush() drains synchronously and clear() drops the queue', () => {
    const timers = fakeTimers();
    let applied = 0;
    const batcher = createEventBatcher({
      apply: (events) => {
        applied += events.length;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    batcher.enqueue(partUpdated('a', ''));
    batcher.flush();
    expect(applied).toBe(1);
    expect(timers.pending()).toBe(0);

    batcher.enqueue(partUpdated('b', ''));
    batcher.clear();
    timers.advance(1_000);
    expect(applied).toBe(1);
  });
});
