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

  test('hold keeps the panel open when the pointer leaves onto portaled menu content', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    flush();
    controller.hold(true); // menu opens
    controller.leave(); // pointer travels onto the portaled menu
    expect(pending.size).toBe(0);
    flush();
    expect(calls).toEqual([true]);
  });

  test('hold cancels a close already armed by the leave-to-portal', () => {
    const { controller, calls, flush } = createHarness();
    controller.enter();
    flush();
    controller.leave(); // arms close
    controller.hold(true); // menu opens right after
    flush();
    expect(calls).toEqual([true]);
  });

  test('releasing the last hold re-arms close when the pointer is away', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    flush();
    controller.hold(true);
    controller.leave();
    controller.hold(false, () => false); // menu closes, pointer off panel
    expect([...pending.values()][0]?.ms).toBe(SIDEBAR_PEEK_CLOSE_DELAY_MS);
    flush();
    expect(calls).toEqual([true, false]);
  });

  test('releasing the last hold keeps the panel open when the pointer is back on it', () => {
    const { controller, calls, pending, flush } = createHarness();
    controller.enter();
    flush();
    controller.hold(true);
    controller.hold(false, () => true); // menu closes, pointer over panel
    expect(pending.size).toBe(0);
    flush();
    expect(calls).toEqual([true]);
  });

  test('nested holds only re-arm close after the final release', () => {
    const { controller, calls, flush } = createHarness();
    controller.enter();
    flush();
    controller.hold(true);
    controller.hold(true);
    controller.hold(false, () => false);
    expect(calls).toEqual([true]); // still one hold outstanding
    controller.hold(false, () => false);
    flush();
    expect(calls).toEqual([true, false]);
  });

  test('cancel clears outstanding holds', () => {
    const { controller, calls, flush } = createHarness();
    controller.enter();
    flush();
    controller.hold(true);
    controller.cancel();
    expect(calls).toEqual([true, false]);
    // A stale leave after cancel must not resurrect a close via the old hold.
    controller.leave();
    flush();
    expect(calls).toEqual([true, false]);
  });
});
