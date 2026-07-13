import { beforeEach, describe, expect, test } from 'bun:test';

import {
  shouldBeginSessionSwitch,
  shouldShowSessionSwitchLoading,
  useSessionSwitchStore,
} from './session-switch-store';

describe('shouldBeginSessionSwitch', () => {
  test('starts a switch for an unmodified primary click on another session', () => {
    expect(
      shouldBeginSessionSwitch(
        { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
        'session-b',
        'session-a',
      ),
    ).toBe(true);
  });

  test('does not hijack same-session, modified, or middle-button navigation', () => {
    expect(
      shouldBeginSessionSwitch(
        { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
        'session-a',
        'session-a',
      ),
    ).toBe(false);
    expect(
      shouldBeginSessionSwitch(
        { button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        'session-b',
        'session-a',
      ),
    ).toBe(false);
    expect(
      shouldBeginSessionSwitch(
        { button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
        'session-b',
        'session-a',
      ),
    ).toBe(false);
  });
});

describe('session switch state', () => {
  beforeEach(() => useSessionSwitchStore.setState({ targetSessionId: null }));

  test('keeps the newest target when an older rapid switch finishes later', () => {
    const state = useSessionSwitchStore.getState();
    state.beginSwitch('session-b');
    useSessionSwitchStore.getState().beginSwitch('session-c');

    useSessionSwitchStore.getState().completeSwitch('session-b');
    expect(useSessionSwitchStore.getState().targetSessionId).toBe('session-c');

    useSessionSwitchStore.getState().completeSwitch('session-c');
    expect(useSessionSwitchStore.getState().targetSessionId).toBeNull();
  });
});

describe('shouldShowSessionSwitchLoading', () => {
  test('covers both the route transition and the target runtime boot', () => {
    expect(shouldShowSessionSwitchLoading('session-b', 'session-a', false)).toBe(true);
    expect(shouldShowSessionSwitchLoading('session-b', 'session-b', false)).toBe(true);
    expect(shouldShowSessionSwitchLoading('session-b', 'session-b', true)).toBe(false);
  });

  test('does not affect ordinary session boot when no click switch is pending', () => {
    expect(shouldShowSessionSwitchLoading(null, 'session-b', false)).toBe(false);
  });
});
