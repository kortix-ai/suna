import { describe, expect, test } from 'bun:test';

import { anchorOutcomes, type TurnSpan } from './anchor-outcomes';
import type { Outcome } from './outcome-types';

function outcome(id: string, at: number): Outcome {
  return {
    id,
    kind: 'change_request',
    title: id,
    description: '',
    status: { label: 'Waiting for you', tone: 'warning' },
    at,
    meta: [],
    action: { label: 'Review', intent: 'open' },
    resourceHref: null,
  };
}

const spans: TurnSpan[] = [
  { key: 't1', startedAt: 100, endedAt: 200 },
  { key: 't2', startedAt: 300, endedAt: 400 },
];

describe('anchorOutcomes', () => {
  test('an outcome lands on the turn whose span contains it', () => {
    const map = anchorOutcomes([outcome('a', 150)], spans);
    expect(map.get('t1')?.map((o) => o.id)).toEqual(['a']);
    expect(map.get('t2')).toBeUndefined();
  });

  test('an outcome created after the last turn ended lands on the last turn', () => {
    // A change request is written moments after the turn's final message, so
    // "after the end" is the COMMON case, not an edge case.
    const map = anchorOutcomes([outcome('a', 5_000)], spans);
    expect(map.get('t2')?.map((o) => o.id)).toEqual(['a']);
  });

  test('an outcome in the gap between two turns lands on the earlier one', () => {
    const map = anchorOutcomes([outcome('a', 250)], spans);
    expect(map.get('t1')?.map((o) => o.id)).toEqual(['a']);
  });

  test('an outcome older than the first turn lands on the first turn', () => {
    const map = anchorOutcomes([outcome('a', 1)], spans);
    expect(map.get('t1')?.map((o) => o.id)).toEqual(['a']);
  });

  test('outcomes on one turn are ordered oldest first', () => {
    const map = anchorOutcomes([outcome('b', 180), outcome('a', 120)], spans);
    expect(map.get('t1')?.map((o) => o.id)).toEqual(['a', 'b']);
  });

  test('a turn with no end still absorbs — a streaming turn is not a black hole', () => {
    // Two spans, not one. With a single span `target` resolves to `spans[0]`
    // whatever the comparison does, so a one-span fixture cannot tell correct
    // matching apart from an inverted or always-false test.
    const map = anchorOutcomes(
      [outcome('a', 350)],
      [
        { key: 't1', startedAt: 100, endedAt: 200 },
        { key: 't2', startedAt: 300, endedAt: null },
      ],
    );
    expect(map.get('t2')?.map((o) => o.id)).toEqual(['a']);
    expect(map.get('t1')).toBeUndefined();
  });

  test('an outcome at the exact instant a later turn started belongs to that turn', () => {
    // Pins the boundary. Flipping `<=` to `<` would misfile this and every
    // other test would stay green.
    const map = anchorOutcomes([outcome('a', 300)], spans);
    expect(map.get('t2')?.map((o) => o.id)).toEqual(['a']);
  });

  test('spans out of chronological order still anchor by time, not by position', () => {
    // The regression this function's loop was rewritten for. Ordered by start
    // these are 50, 100, 200; listed here they are not. An outcome at 150
    // belongs to the span starting at 100 — never to the one starting at 50
    // merely because it appears last in the array.
    const jumbled: TurnSpan[] = [
      { key: 'A', startedAt: 100, endedAt: 150 },
      { key: 'B', startedAt: 200, endedAt: 250 },
      { key: 'C', startedAt: 50, endedAt: 90 },
    ];
    const map = anchorOutcomes([outcome('a', 150)], jumbled);
    expect(map.get('A')?.map((o) => o.id)).toEqual(['a']);
    expect(map.get('C')).toBeUndefined();
  });

  test('no turns yields an empty map rather than throwing', () => {
    expect(anchorOutcomes([outcome('a', 150)], []).size).toBe(0);
  });

  test('an outcome with at=0 still anchors — an unparseable date is not a dropped card', () => {
    const map = anchorOutcomes([outcome('a', 0)], spans);
    expect(map.get('t1')?.map((o) => o.id)).toEqual(['a']);
  });
});
