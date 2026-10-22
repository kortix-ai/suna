import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';

/**
 * About 12 `AppState` handlers fire on the same tick when the app returns to
 * the foreground. Work that can wait (warm session, push registration, the OTA
 * check) runs a moment later, and not at all if the app leaves again first.
 * Fake timers: no wall-clock margins to flake under the concurrent suite.
 */

let listeners: Array<(state: string) => void> = [];
let removed = 0;

mock.module('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, fn: (state: string) => void) => {
      listeners.push(fn);
      return {
        remove: () => {
          removed += 1;
          listeners = listeners.filter((l) => l !== fn);
        },
      };
    },
  },
}));

const { addResumeListener } = await import('./app-resume');

const emit = (state: string) => listeners.forEach((l) => l(state));
const advance = (ms: number) => jest.advanceTimersByTime(ms);

beforeEach(() => {
  jest.useFakeTimers();
  listeners = [];
  removed = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

test('runs the callback once, the delay after the app returns to the foreground', () => {
  let calls = 0;
  addResumeListener(() => (calls += 1), 400);
  emit('active');
  expect(calls).toBe(0);
  advance(399);
  expect(calls).toBe(0);
  advance(1);
  expect(calls).toBe(1);
  advance(10_000);
  expect(calls).toBe(1);
});

test('leaving the foreground before the delay cancels the run', () => {
  let calls = 0;
  addResumeListener(() => (calls += 1), 400);
  emit('active');
  advance(200);
  emit('inactive');
  emit('background');
  advance(10_000);
  expect(calls).toBe(0);
});

test('a second return restarts the delay: one run, not two', () => {
  let calls = 0;
  addResumeListener(() => (calls += 1), 400);
  emit('active');
  advance(300);
  emit('inactive');
  emit('active');
  advance(300);
  expect(calls).toBe(0);
  advance(100);
  expect(calls).toBe(1);
  advance(10_000);
  expect(calls).toBe(1);
});

test('the unsubscribe removes the listener and cancels a pending run', () => {
  let calls = 0;
  const stop = addResumeListener(() => (calls += 1), 400);
  emit('active');
  stop();
  advance(10_000);
  expect(calls).toBe(0);
  expect(removed).toBe(1);
  expect(listeners).toEqual([]);
});
