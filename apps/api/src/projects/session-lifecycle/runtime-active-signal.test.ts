import { expect, test } from 'bun:test';

import {
  armSessionRuntimeActive,
  signalSessionRuntimeActive,
  waitForSessionRuntimeActive,
} from './runtime-active-signal';

test('a signal that lands between arming and the wait is kept: the wait returns at once', async () => {
  const armed = armSessionRuntimeActive('sess-arm');
  // The delivery is still reading the session when the box reports ready.
  signalSessionRuntimeActive('sess-arm');
  const startedAt = performance.now();
  expect(await armed.wait(3_000)).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(50);
  // The armed listener is gone: a later wait sees no stale signal.
  expect(await waitForSessionRuntimeActive('sess-arm', 20)).toBe(false);
});

test('an armed listener that is cancelled keeps nothing registered', async () => {
  const armed = armSessionRuntimeActive('sess-cancel');
  armed.cancel();
  armed.cancel();
  signalSessionRuntimeActive('sess-cancel');
  expect(await waitForSessionRuntimeActive('sess-cancel', 20)).toBe(false);
});

test('cancelling a pending wait settles it false at once', async () => {
  const armed = armSessionRuntimeActive('sess-cancel-wait');
  const waiting = armed.wait(3_000);
  const startedAt = performance.now();
  armed.cancel();
  expect(await waiting).toBe(false);
  expect(performance.now() - startedAt).toBeLessThan(50);
});

test('a signal before arming is not replayed: arming starts a clean listener', async () => {
  signalSessionRuntimeActive('sess-before');
  const armed = armSessionRuntimeActive('sess-before');
  expect(await armed.wait(20)).toBe(false);
});

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
