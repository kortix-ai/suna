import { describe, expect, test } from 'bun:test';

import { createStreamRevival } from './stream-revival';

function harness() {
  const timers: Array<{ handler: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const listeners = new Map<string, Set<() => void>>();
  let revives = 0;
  const revival = createStreamRevival(() => {
    revives += 1;
  }, {
    reviveAfterMs: 30_000,
    setTimeout: (handler, ms) => {
      const id = nextId++;
      timers.push({ handler, ms, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    listen: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)!.delete(handler);
    },
  });
  return {
    revival,
    revives: () => revives,
    fire: (event: string) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
    tick: () => {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.handler();
    },
    armedEvents: () => [...listeners.keys()].filter((key) => (listeners.get(key)?.size ?? 0) > 0),
  };
}

/**
 * A parked stream is terminal by design — it stops hammering a dead sandbox.
 * Nothing revived it, so "terminal for this handle" became "terminal for this
 * page": the session view kept rendering a transcript nobody was updating
 * until the user reloaded.
 */
describe('createStreamRevival', () => {
  test('an idle park revives on its own after the delay', () => {
    const h = harness();
    h.revival.park();
    expect(h.revives()).toBe(0);

    h.tick();
    expect(h.revives()).toBe(1);
  });

  test('coming back to the tab revives immediately', () => {
    const h = harness();
    h.revival.park();

    h.fire('visibilitychange');
    expect(h.revives()).toBe(1);
  });

  test('the network coming back revives immediately', () => {
    const h = harness();
    h.revival.park();

    h.fire('online');
    expect(h.revives()).toBe(1);
  });

  test('whichever trigger lands first, the stream is revived exactly once', () => {
    const h = harness();
    h.revival.park();

    h.fire('online');
    h.fire('visibilitychange');
    h.tick();
    expect(h.revives()).toBe(1);
    expect(h.armedEvents()).toEqual([]);
  });

  test('parking twice arms one revival, not two', () => {
    const h = harness();
    h.revival.park();
    h.revival.park();

    h.tick();
    expect(h.revives()).toBe(1);
  });

  test('teardown before any trigger revives nothing', () => {
    const h = harness();
    h.revival.park();
    h.revival.stop();

    h.fire('online');
    h.tick();
    expect(h.revives()).toBe(0);
  });
});
