import { describe, expect, test } from 'bun:test';

import {
  nextFocusAfterRemove,
  queueSummaryLabel,
  reorderTargetIndex,
  reorderToPendingIndex,
} from './queued-messages-logic';

describe('queueSummaryLabel', () => {
  test('says what will happen, not just how many', () => {
    expect(queueSummaryLabel(1)).toBe('1 queued · sends when this turn ends');
  });

  test('says all of them send, because all of them do', () => {
    // The queue drains as one batch. "4 queued · sends when this turn ends"
    // reads as a schedule — one now, three later — which is the behaviour this
    // surface used to have and no longer does.
    expect(queueSummaryLabel(4)).toBe('4 queued · all send when this turn ends');
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

describe('reorderToPendingIndex', () => {
  test('maps a visible slot to the full pending array', () => {
    // 'a' and 'b' are in flight and hidden; visible list is c, d, e.
    const pending = ['a', 'b', 'c', 'd', 'e'];
    const visible = ['c', 'd', 'e'];
    // Moving 'd' to slot 0 lands where 'c' sits in the FULL array: 2, not 0.
    expect(reorderToPendingIndex(visible, pending, 'd', 0)).toBe(2);
    expect(reorderToPendingIndex(visible, pending, 'd', 2)).toBe(4);
  });

  test('maps a multi-slot drag, both directions', () => {
    const pending = ['a', 'b', 'c', 'd'];
    // Dragging 'a' to the last slot targets where 'd' sits.
    expect(reorderToPendingIndex(pending, pending, 'a', 3)).toBe(3);
    expect(reorderToPendingIndex(pending, pending, 'd', 0)).toBe(0);
  });

  test('returns null for a no-op or out-of-range slot', () => {
    const pending = ['a', 'b', 'c'];
    expect(reorderToPendingIndex(pending, pending, 'a', 0)).toBeNull();
    expect(reorderToPendingIndex(pending, pending, 'a', -1)).toBeNull();
    expect(reorderToPendingIndex(pending, pending, 'c', 3)).toBeNull();
  });

  test('returns null for a row that is not visible', () => {
    // An in-flight row cannot move, however the call was reached.
    expect(reorderToPendingIndex(['b', 'c'], ['a', 'b', 'c'], 'a', 1)).toBeNull();
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
