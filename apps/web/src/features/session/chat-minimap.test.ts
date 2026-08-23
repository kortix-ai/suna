import { describe, expect, test } from 'bun:test';

import { activeTurnIdAt, nearestListedTurnId } from './chat-minimap';
import type { TimelineVirtualApi } from './timeline/timeline-virtual';

/** A virtual API over turns `t0..t<n-1>`, each `size` px tall from 0. */
function fakeApi(count: number, size: number): TimelineVirtualApi {
  const ids = Array.from({ length: count }, (_, i) => `t${i}`);
  return {
    turnIndex: (id) => (ids.includes(id) ? ids.indexOf(id) : undefined),
    turnStart: (id) => (ids.includes(id) ? ids.indexOf(id) * size : undefined),
    turnAtOffset: (offset) =>
      count === 0 ? undefined : ids[Math.max(0, Math.min(count - 1, Math.floor(offset / size)))],
    isMounted: () => true,
    scrollToTurn: () => true,
    measure: () => {},
  };
}

/** A scroll element: `scrollTop`, `clientHeight`, a rect at `top`. */
function scrollEl(scrollTop: number, clientHeight: number): HTMLElement {
  return {
    scrollTop,
    clientHeight,
    getBoundingClientRect: () => ({ top: 0 }),
  } as unknown as HTMLElement;
}

/** A flat-list content element with turn elements at content-space tops. */
function contentEl(turns: Array<{ id: string; top: number }>, scrollTop: number): HTMLElement {
  const elements = turns.map((turn) => ({
    getAttribute: (name: string) => (name === 'data-turn-id' ? turn.id : null),
    // Viewport-relative, as a real rect is: content top minus the scroll.
    getBoundingClientRect: () => ({ top: turn.top - scrollTop }),
  }));
  return {
    querySelectorAll: () => elements,
  } as unknown as HTMLElement;
}

describe('activeTurnIdAt — the turn under the viewport midpoint', () => {
  test('virtual list: one geometry lookup at scrollTop + clientHeight / 2', () => {
    const api = fakeApi(40, 160);
    // Midpoint 1000 + 450 = 1450 → turn 9 (1440..1600).
    expect(
      activeTurnIdAt({ api, scrollEl: scrollEl(1000, 900), contentEl: contentEl([], 1000) }),
    ).toBe('t9');
    expect(activeTurnIdAt({ api, scrollEl: scrollEl(0, 900), contentEl: contentEl([], 0) })).toBe(
      't2',
    );
  });

  test('flat list: the last mounted turn that starts at or above the midpoint', () => {
    const turns = [
      { id: 'a', top: 0 },
      { id: 'b', top: 500 },
      { id: 'c', top: 1200 },
    ];
    // Midpoint 450 → 'a'; 950 → 'b'; 5000 → 'c'.
    expect(
      activeTurnIdAt({ api: null, scrollEl: scrollEl(0, 900), contentEl: contentEl(turns, 0) }),
    ).toBe('a');
    expect(
      activeTurnIdAt({ api: null, scrollEl: scrollEl(500, 900), contentEl: contentEl(turns, 500) }),
    ).toBe('b');
    expect(
      activeTurnIdAt({
        api: null,
        scrollEl: scrollEl(4550, 900),
        contentEl: contentEl(turns, 4550),
      }),
    ).toBe('c');
  });

  test('nothing mounted, nothing active', () => {
    expect(
      activeTurnIdAt({ api: null, scrollEl: scrollEl(0, 900), contentEl: contentEl([], 0) }),
    ).toBe(null);
    expect(
      activeTurnIdAt({
        api: fakeApi(0, 160),
        scrollEl: scrollEl(0, 900),
        contentEl: contentEl([], 0),
      }),
    ).toBe(null);
  });
});

describe('nearestListedTurnId — a turn without a preview maps to the listed turn at or before it', () => {
  const order = new Map([
    ['t0', 0],
    ['t1', 1],
    ['t2', 2],
    ['t3', 3],
    ['t4', 4],
  ]);
  const listed = new Set(['t0', 't2', 't4']);
  test('a listed turn is itself', () => {
    expect(nearestListedTurnId('t2', order, listed)).toBe('t2');
  });
  test('an unlisted turn maps to the nearest listed one before it', () => {
    expect(nearestListedTurnId('t3', order, listed)).toBe('t2');
    expect(nearestListedTurnId('t1', order, listed)).toBe('t0');
  });
  test('nothing before it, or an unknown / null turn, maps to nothing', () => {
    expect(nearestListedTurnId('t1', order, new Set(['t2']))).toBe(null);
    expect(nearestListedTurnId('ghost', order, listed)).toBe(null);
    expect(nearestListedTurnId(null, order, listed)).toBe(null);
  });
});
