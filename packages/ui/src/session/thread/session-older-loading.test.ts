import { describe, expect, test } from 'bun:test';

import { OLDER_LOADING_MIN_MS, olderLoadingPhase } from './session-older-loading';

describe('olderLoadingPhase — the older-history row is readable, not a flash', () => {
  test('a pull in flight shows the row', () => {
    expect(olderLoadingPhase({ isLoadingOlder: true, visible: false })).toBe('show');
    expect(olderLoadingPhase({ isLoadingOlder: true, visible: true })).toBe('show');
  });

  test('a pull that landed in 150ms holds the row instead of blinking it away', () => {
    expect(olderLoadingPhase({ isLoadingOlder: false, visible: true })).toBe('hold');
  });

  test('no pull and no row: nothing to say', () => {
    expect(olderLoadingPhase({ isLoadingOlder: false, visible: false })).toBe('hide');
  });

  test('the hold outlasts a 2Hz observer, so a loading state is observable, not a race', () => {
    expect(OLDER_LOADING_MIN_MS).toBeGreaterThan(500);
  });
});
