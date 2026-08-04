import { describe, expect, test } from 'bun:test';

import {
  QUEUE_AUTO_EXPAND_AT,
  nextFocusAfterRemove,
  queueSummaryLabel,
  reorderTargetIndex,
  shouldExpandQueue,
} from './queued-messages-logic';

describe('shouldExpandQueue', () => {
  test('stays collapsed for a short queue', () => {
    expect(shouldExpandQueue(0, null)).toBe(false);
    expect(shouldExpandQueue(1, null)).toBe(false);
    expect(shouldExpandQueue(QUEUE_AUTO_EXPAND_AT - 1, null)).toBe(false);
  });

  test('expands on its own once the queue is long enough to need scanning', () => {
    expect(shouldExpandQueue(QUEUE_AUTO_EXPAND_AT, null)).toBe(true);
    expect(shouldExpandQueue(9, null)).toBe(true);
  });

  test('an explicit choice beats the count, in both directions', () => {
    expect(shouldExpandQueue(9, false)).toBe(false);
    expect(shouldExpandQueue(1, true)).toBe(true);
  });
});

describe('queueSummaryLabel', () => {
  test('says what will happen, not just how many', () => {
    expect(queueSummaryLabel(1)).toBe('1 queued · sends when this turn ends');
    expect(queueSummaryLabel(4)).toBe('4 queued · sends when this turn ends');
  });
});

describe('reorderTargetIndex', () => {
  test('moves within the list', () => {
    expect(reorderTargetIndex(2, 'up', 4, 0)).toBe(1);
    expect(reorderTargetIndex(1, 'down', 4, 0)).toBe(2);
  });

  test('returns null at the ends instead of wrapping', () => {
    // Wrapping would silently send the message the user was demoting.
    expect(reorderTargetIndex(0, 'up', 4, 0)).toBeNull();
    expect(reorderTargetIndex(3, 'down', 4, 0)).toBeNull();
  });

  test('respects the floor set by an in-flight item', () => {
    // Index 0 is already sending. Nothing may move into or above it.
    expect(reorderTargetIndex(1, 'up', 4, 1)).toBeNull();
    expect(reorderTargetIndex(2, 'up', 4, 1)).toBe(1);
  });

  test('returns null for an index outside the list', () => {
    expect(reorderTargetIndex(-1, 'up', 4, 0)).toBeNull();
    expect(reorderTargetIndex(9, 'down', 4, 0)).toBeNull();
  });
});

describe('nextFocusAfterRemove', () => {
  test('moves focus to the row that takes the removed slot', () => {
    expect(nextFocusAfterRemove(['a', 'b', 'c'], 1)).toBe('c');
  });

  test('falls back to the previous row when the last one goes', () => {
    expect(nextFocusAfterRemove(['a', 'b', 'c'], 2)).toBe('b');
  });

  test('returns null when the queue is now empty', () => {
    // Nothing to focus — the caller returns focus to the composer.
    expect(nextFocusAfterRemove(['a'], 0)).toBeNull();
  });

  test('returns null for an index outside the list', () => {
    expect(nextFocusAfterRemove(['a', 'b'], 5)).toBeNull();
  });
});
