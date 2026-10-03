import { expect, test } from 'bun:test';

import { signalSessionRuntimeActive, waitForSessionRuntimeActive } from './runtime-active-signal';

test('a waiting delivery is woken when its session goes active', async () => {
  const startedAt = performance.now();
  const waiting = waitForSessionRuntimeActive('sess-1', 3_000);
  signalSessionRuntimeActive('sess-1');
  expect(await waiting).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(500);
});

test('a signal for another session wakes nobody: the poll interval runs out', async () => {
  const waiting = waitForSessionRuntimeActive('sess-1', 30);
  signalSessionRuntimeActive('sess-2');
  expect(await waiting).toBe(false);
});

test('every delivery waiting on one session is woken, and a late signal finds nobody', async () => {
  const both = Promise.all([
    waitForSessionRuntimeActive('sess-1', 3_000),
    waitForSessionRuntimeActive('sess-1', 3_000),
  ]);
  signalSessionRuntimeActive('sess-1');
  expect(await both).toEqual([true, true]);
  // Nothing is left registered: this returns without throwing or waking.
  signalSessionRuntimeActive('sess-1');
  expect(await waitForSessionRuntimeActive('sess-1', 20)).toBe(false);
});
