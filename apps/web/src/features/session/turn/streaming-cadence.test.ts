import { describe, expect, test } from 'bun:test';

import { STREAM_RENDER_INTERVAL_MS, createStreamingCadence } from './streaming-cadence';

/** A manual clock + timer queue, so every schedule is asserted exactly. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      queue.delete(id);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending: () => queue.size,
  };
}

describe('createStreamingCadence', () => {
  test('the first streamed value shows at once', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const cadence = createStreamingCadence((v) => shown.push(v), timers);
    cadence.push('a', true);
    expect(shown).toEqual(['a']);
  });

  test('a burst inside one interval shows only its last value, once, at the interval edge', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const cadence = createStreamingCadence((v) => shown.push(v), timers);
    cadence.push('a', true);
    for (const v of ['ab', 'abc', 'abcd', 'abcde']) {
      timers.advance(10);
      cadence.push(v, true);
    }
    expect(shown).toEqual(['a']);
    timers.advance(STREAM_RENDER_INTERVAL_MS);
    expect(shown).toEqual(['a', 'abcde']);
    expect(timers.pending()).toBe(0);
  });

  test('200 deltas at 16 ms render at most once per interval, and the final text always lands', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const cadence = createStreamingCadence((v) => shown.push(v), timers);
    let text = '';
    for (let i = 0; i < 200; i++) {
      text += 'x';
      cadence.push(text, true);
      timers.advance(16);
    }
    timers.advance(STREAM_RENDER_INTERVAL_MS);
    expect(shown[shown.length - 1]).toBe(text);
    // 200 × 16 ms = 3.2 s of stream → ~40 renders at 80 ms, not 200.
    expect(shown.length).toBeLessThanOrEqual(Math.ceil((200 * 16) / STREAM_RENDER_INTERVAL_MS) + 1);
    expect(shown.length).toBeGreaterThan(10);
  });

  test('the stream ending flushes the latest value immediately and cancels the trailing timer', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const cadence = createStreamingCadence((v) => shown.push(v), timers);
    cadence.push('a', true);
    timers.advance(5);
    cadence.push('ab', true);
    cadence.push('ab!', false);
    expect(shown).toEqual(['a', 'ab!']);
    expect(timers.pending()).toBe(0);
  });

  test('dispose cancels a pending trailing update', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const cadence = createStreamingCadence((v) => shown.push(v), timers);
    cadence.push('a', true);
    cadence.push('ab', true);
    cadence.dispose();
    timers.advance(1000);
    expect(shown).toEqual(['a']);
  });

  test('an unchanged value schedules nothing', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const cadence = createStreamingCadence((v) => shown.push(v), timers);
    cadence.push('a', true);
    cadence.push('a', true);
    expect(timers.pending()).toBe(0);
    expect(shown).toEqual(['a']);
  });
});
