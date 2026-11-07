import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

let onState: ((state: string) => void) | undefined;
mock.module('react-native', () => ({
  AppState: {
    currentState: 'background',
    addEventListener: (_: string, listener: (state: string) => void) => {
      onState = listener;
      return { remove: () => { onState = undefined; } };
    },
  },
  Keyboard: { isVisible: () => false },
}));
const { useFieldRefocus } = await import('./use-field-refocus');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
});

test('foreground transitions replace pending refocus and unmount cancels the last request', () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const setTimer = mock(() => {});
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const blur = mock(() => {});
  const focus = mock(() => {});
  function Field() {
    useFieldRefocus({ current: { blur, focus } } as unknown as React.RefObject<import('react-native').TextInputInstance>);
    return null;
  }
  try {
    globalThis.setTimeout = ((callback: () => void) => {
      setTimer();
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
    act(() => { tree = create(<Field />); });
    act(() => { onState?.('active'); onState?.('background'); onState?.('active'); });
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(1);
    act(() => { tree!.unmount(); tree = undefined; });
    expect(timers.size).toBe(0);
    expect(onState).toBeUndefined();
    expect(blur).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
