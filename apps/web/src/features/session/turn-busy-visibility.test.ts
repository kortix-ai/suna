import { describe, expect, test } from 'bun:test';

import { showTurnBusyIndicator } from './turn-busy-visibility';

describe('showTurnBusyIndicator', () => {
  test('shows the indicator for a live turn with no error', () => {
    expect(showTurnBusyIndicator({ working: true, hasError: false, isRetrying: false })).toBe(true);
  });

  test('hides it once the turn reports an error', () => {
    expect(showTurnBusyIndicator({ working: true, hasError: true, isRetrying: false })).toBe(false);
  });

  test('keeps it while a retry is counting down', () => {
    expect(showTurnBusyIndicator({ working: true, hasError: true, isRetrying: true })).toBe(true);
  });

  test('never shows it for a turn that is not working', () => {
    expect(showTurnBusyIndicator({ working: false, hasError: false, isRetrying: false })).toBe(
      false,
    );
    expect(showTurnBusyIndicator({ working: false, hasError: true, isRetrying: true })).toBe(false);
  });
});

describe('showTurnBusyIndicator — waiting on the user', () => {
  test('hides it while a question or permission is pending', () => {
    expect(
      showTurnBusyIndicator({
        working: true,
        hasError: false,
        isRetrying: false,
        awaitingUser: true,
      }),
    ).toBe(false);
  });

  test('outranks a retry countdown: nothing bounds an unanswered question', () => {
    expect(
      showTurnBusyIndicator({
        working: true,
        hasError: true,
        isRetrying: true,
        awaitingUser: true,
      }),
    ).toBe(false);
  });

  test('comes back the moment the answer lands', () => {
    expect(
      showTurnBusyIndicator({
        working: true,
        hasError: false,
        isRetrying: false,
        awaitingUser: false,
      }),
    ).toBe(true);
  });

  test('an absent flag is the old behaviour, unchanged', () => {
    expect(showTurnBusyIndicator({ working: true, hasError: false, isRetrying: false })).toBe(true);
  });
});
