import { describe, expect, test } from 'bun:test';

import { SESSION_OPEN_INTENT_DELAY_MS, createSessionOpenIntent } from './session-open-intent';

function fakeClock() {
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let next = 1;
  return {
    schedule: (callback: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    cancel: (handle: unknown) => void timers.delete(handle as number),
    advance: (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe('createSessionOpenIntent', () => {
  test('a resting pointer starts the open read after the delay', () => {
    const clock = fakeClock();
    let starts = 0;
    const intent = createSessionOpenIntent(() => starts++, clock.schedule, clock.cancel);
    intent.pointerEnter();
    clock.advance(SESSION_OPEN_INTENT_DELAY_MS - 1);
    expect(starts).toBe(0);
    clock.advance(1);
    expect(starts).toBe(1);
  });

  test('a pointer sweeping past the row starts nothing', () => {
    const clock = fakeClock();
    let starts = 0;
    const intent = createSessionOpenIntent(() => starts++, clock.schedule, clock.cancel);
    intent.pointerEnter();
    clock.advance(SESSION_OPEN_INTENT_DELAY_MS / 2);
    intent.pointerLeave();
    clock.advance(SESSION_OPEN_INTENT_DELAY_MS * 4);
    expect(starts).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  test('focus and touch start at once and cancel a pending pointer start', () => {
    const clock = fakeClock();
    let starts = 0;
    const intent = createSessionOpenIntent(() => starts++, clock.schedule, clock.cancel);
    intent.pointerEnter();
    intent.immediate();
    expect(starts).toBe(1);
    clock.advance(SESSION_OPEN_INTENT_DELAY_MS * 2);
    expect(starts).toBe(1);
  });

  test('dispose cancels a pending start', () => {
    const clock = fakeClock();
    let starts = 0;
    const intent = createSessionOpenIntent(() => starts++, clock.schedule, clock.cancel);
    intent.pointerEnter();
    intent.dispose();
    clock.advance(SESSION_OPEN_INTENT_DELAY_MS * 2);
    expect(starts).toBe(0);
  });
});
