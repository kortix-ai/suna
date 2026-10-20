import { describe, expect, test } from 'bun:test';

import { clampSelection, moveSelection } from './menu-selection';

describe('moveSelection', () => {
  test('wraps at both ends so the list feels circular', () => {
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  test('moves normally in the middle', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  test('stays at 0 for an empty list instead of returning NaN', () => {
    // n % 0 is NaN, which would render an undefined row.
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe('clampSelection', () => {
  test('pulls an out-of-range index back to the last row', () => {
    // Replaces the clamp effect at session-chat-input.tsx:704.
    expect(clampSelection(7, 3)).toBe(2);
  });

  test('leaves an in-range index alone', () => {
    expect(clampSelection(1, 3)).toBe(1);
  });

  test('returns 0 for an empty list', () => {
    expect(clampSelection(3, 0)).toBe(0);
  });
});
