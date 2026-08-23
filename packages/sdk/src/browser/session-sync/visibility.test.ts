import { describe, expect, test } from 'bun:test';

import { onTabVisible, type VisibilityTarget } from './visibility';

function fakeTarget(initial = 'visible') {
  const handlers = new Set<() => void>();
  const target: VisibilityTarget & { fire: (state: string) => void } = {
    visibilityState: initial,
    addEventListener: (_type, handler) => {
      handlers.add(handler);
    },
    removeEventListener: (_type, handler) => {
      handlers.delete(handler);
    },
    fire: (state: string) => {
      target.visibilityState = state;
      for (const handler of [...handlers]) handler();
    },
  };
  return target;
}

describe('onTabVisible', () => {
  test('runs on the return to the foreground', () => {
    const target = fakeTarget('hidden');
    let runs = 0;
    onTabVisible(() => {
      runs += 1;
    }, target);

    target.fire('visible');
    expect(runs).toBe(1);
  });

  test('leaving the tab repairs nothing, so it runs nothing', () => {
    const target = fakeTarget('visible');
    let runs = 0;
    onTabVisible(() => {
      runs += 1;
    }, target);

    target.fire('hidden');
    expect(runs).toBe(0);
  });

  test('unsubscribing detaches the listener', () => {
    const target = fakeTarget('hidden');
    let runs = 0;
    const stop = onTabVisible(() => {
      runs += 1;
    }, target);

    stop();
    target.fire('visible');
    expect(runs).toBe(0);
  });

  test('no document, no listener, no throw', () => {
    expect(() => onTabVisible(() => {}, undefined)()).not.toThrow();
  });
});
