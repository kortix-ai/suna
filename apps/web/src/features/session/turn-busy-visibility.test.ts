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
