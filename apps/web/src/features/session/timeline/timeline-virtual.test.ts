import { afterEach, describe, expect, test } from 'bun:test';

import {
  MEASUREMENT_SNAPSHOTS_MAX,
  __testing,
  isFollowing,
  pinnedTurnIndexes,
  recallTimelineMeasurements,
  rememberTimelineMeasurements,
  shouldAdjustForResize,
  timelineRangeIndexes,
  turnGapBelowClass,
} from './timeline-virtual';

afterEach(() => __testing.clearSnapshots());

describe('turnGapBelowClass — the flat list’s top margin, moved to the previous item’s bottom', () => {
  const pendingTurnIds = new Set(['b', 'c']);
  const below = (
    index: number,
    id: string,
    next: string | undefined,
    working: boolean,
    count = 3,
  ) =>
    turnGapBelowClass({
      index,
      count,
      userMessageID: id,
      nextUserMessageID: next,
      lastTurnWorking: working,
      pendingTurnIds,
    });

  test('the last turn carries no gap below (nothing follows it)', () => {
    expect(below(2, 'c', undefined, true)).toBe('');
    expect(below(2, 'c', 'd', true)).toBe('');
  });

  test('a turn followed by an ordinary turn gets pb-12 — the mt-12 the next turn would carry', () => {
    expect(below(0, 'a', 'b', false)).toBe('pb-12');
  });

  test('a pending turn followed by another pending turn, while working, gets pb-3 (stacked)', () => {
    expect(below(1, 'b', 'c', true)).toBe('pb-3');
    // Stacking is a WORKING-session rule only.
    expect(below(1, 'b', 'c', false)).toBe('pb-12');
  });
});

describe('shouldAdjustForResize — the only scroll correction the list makes on its own', () => {
  test('never while following: use-auto-scroll owns the end', () => {
    expect(shouldAdjustForResize({ following: true, itemIndex: 0, rangeStartIndex: 5 })).toBe(
      false,
    );
  });
  test('not following: only a turn ABOVE the visible range moves the viewport', () => {
    expect(shouldAdjustForResize({ following: false, itemIndex: 2, rangeStartIndex: 5 })).toBe(
      true,
    );
    expect(shouldAdjustForResize({ following: false, itemIndex: 5, rangeStartIndex: 5 })).toBe(
      false,
    );
    expect(shouldAdjustForResize({ following: false, itemIndex: 9, rangeStartIndex: 5 })).toBe(
      false,
    );
  });
  test('no range yet: no correction', () => {
    expect(
      shouldAdjustForResize({ following: false, itemIndex: 0, rangeStartIndex: undefined }),
    ).toBe(false);
  });
  test('isFollowing reads the follow bit use-auto-scroll mirrors onto the scroll element', () => {
    expect(isFollowing({ dataset: { follow: 'true' } })).toBe(true);
    expect(isFollowing({ dataset: { follow: 'false' } })).toBe(false);
    expect(isFollowing({ dataset: {} })).toBe(false);
    expect(isFollowing(null)).toBe(false);
  });
});

describe('pinnedTurnIndexes — the tail stays mounted wherever the reader is', () => {
  const indexById = new Map([
    ['t0', 0],
    ['t1', 1],
    ['t2', 2],
    ['t3', 3],
    ['t4', 4],
  ]);
  test('always the last turn', () => {
    expect(
      pinnedTurnIndexes({
        count: 5,
        indexById,
        workingTurnId: null,
        pendingTurnIds: new Set(),
        interruptedTurnIds: new Set(),
      }),
    ).toEqual([4]);
  });
  test('the working turn and the pending / interrupted bubbles behind it, ascending, unique', () => {
    expect(
      pinnedTurnIndexes({
        count: 5,
        indexById,
        workingTurnId: 't2',
        pendingTurnIds: new Set(['t3', 't4']),
        interruptedTurnIds: new Set(['t4']),
      }),
    ).toEqual([2, 3, 4]);
  });
  test('unknown ids and an empty list pin nothing', () => {
    expect(
      pinnedTurnIndexes({
        count: 0,
        indexById: new Map(),
        workingTurnId: 'ghost',
        pendingTurnIds: new Set(['x']),
        interruptedTurnIds: new Set(),
      }),
    ).toEqual([]);
  });
});

describe('timelineRangeIndexes — visible range + render overscan + pinned, clamped', () => {
  test('widens the range by the RENDER overscan (not virtual-core’s) and adds pinned indexes', () => {
    expect(timelineRangeIndexes({ startIndex: 10, endIndex: 12, count: 100 }, 2, [99, 50])).toEqual(
      [8, 9, 10, 11, 12, 13, 14, 50, 99],
    );
  });
  test('clamps to the list and drops out-of-range or non-integer pins', () => {
    expect(
      timelineRangeIndexes({ startIndex: 0, endIndex: 1, count: 3 }, 5, [7, -1, 1.5, 2]),
    ).toEqual([0, 1, 2]);
  });
});

describe('measurement snapshots across session switches', () => {
  const item = (index: number) => ({
    index,
    key: `k${index}`,
    start: index * 100,
    size: 100,
    end: index * 100 + 100,
    lane: 0,
  });
  test('remember → recall, and an empty snapshot forgets the session', () => {
    rememberTimelineMeasurements('s1', [item(0), item(1)]);
    expect(recallTimelineMeasurements('s1')).toHaveLength(2);
    rememberTimelineMeasurements('s1', []);
    expect(recallTimelineMeasurements('s1')).toBeUndefined();
  });
  test('keeps the newest MEASUREMENT_SNAPSHOTS_MAX sessions', () => {
    for (let i = 0; i <= MEASUREMENT_SNAPSHOTS_MAX; i++) {
      rememberTimelineMeasurements(`s${i}`, [item(0)]);
    }
    expect(recallTimelineMeasurements('s0')).toBeUndefined();
    expect(recallTimelineMeasurements(`s${MEASUREMENT_SNAPSHOTS_MAX}`)).toHaveLength(1);
    // Re-remembering moves a session to the newest slot.
    rememberTimelineMeasurements('s1', [item(0)]);
    rememberTimelineMeasurements('s-new', [item(0)]);
    expect(recallTimelineMeasurements('s1')).toHaveLength(1);
    expect(recallTimelineMeasurements('s2')).toBeUndefined();
  });
});
