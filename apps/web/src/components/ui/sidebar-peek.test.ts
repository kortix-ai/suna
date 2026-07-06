import { describe, expect, test } from 'bun:test';

import {
  createPeekController,
  SIDEBAR_PEEK_CLOSE_DELAY_MS,
  SIDEBAR_PEEK_OPEN_DELAY_MS,
} from './sidebar-peek';

function createHarness() {
  const calls: boolean[] = [];
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;

  const controller = createPeekController(
    (peek) => calls.push(peek),
    (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    (id) => {
      pending.delete(id as unknown as number);
    },
  );

  const flush = () => {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [, entry] of entries) entry.fn();
  };

  return { controller, calls, pending, flush };
}

describe('createPeekController', () => {
  test('opens only after the open delay elapses', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    expect(calls).toEqual([]);
    expect([...pending.values()][0]?.ms).toBe(SIDEBAR_PEEK_OPEN_DELAY_MS);
    flush();
    expect(calls).toEqual([true]);
  });

  test('grazing the edge never opens when leave lands before the delay', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    controller.leave();
    expect(pending.size).toBe(0);
    flush();
    expect(calls).toEqual([]);
  });

  test('re-entering during a pending close keeps the panel open', () => {
    const { controller, calls, flush } = createHarness();
    controller.enter();
    flush();
    controller.leave();
    controller.enter();
    flush();
    expect(calls).toEqual([true]);
  });

  test('closes after the close delay once the pointer leaves', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    flush();
    controller.leave();
    expect([...pending.values()][0]?.ms).toBe(SIDEBAR_PEEK_CLOSE_DELAY_MS);
    flush();
    expect(calls).toEqual([true, false]);
  });

  test('cancel drops the peek immediately and clears pending timers', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    flush();
    controller.cancel();
    expect(calls).toEqual([true, false]);
    expect(pending.size).toBe(0);
    flush();
    expect(calls).toEqual([true, false]);
  });

  test('entering while already open schedules nothing', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    flush();
    controller.enter();
    expect(pending.size).toBe(0);
    flush();
    expect(calls).toEqual([true]);
  });
});
