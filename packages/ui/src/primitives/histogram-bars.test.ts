import { describe, expect, test } from 'bun:test';

import { HIDDEN_CARD, histogramCardOffset, nextCardState } from './histogram-bars';

describe('histogramCardOffset', () => {
  test('centres the card on its bar', () => {
    // Bar 24 of 48 in a 480 px strip is centred at 245 px; a 200 px card starts at 145.
    expect(histogramCardOffset(24, 48, 480, 200)).toBeCloseTo(145);
  });
  test('clamps at the left and right edges', () => {
    expect(histogramCardOffset(0, 48, 480, 200)).toBe(0);
    expect(histogramCardOffset(47, 48, 480, 200)).toBe(280);
  });
  test('a card wider than the strip pins to the left; no strip yet reads 0', () => {
    expect(histogramCardOffset(10, 48, 150, 200)).toBe(0);
    expect(histogramCardOffset(10, 48, 0, 200)).toBe(0);
  });
});

describe('nextCardState', () => {
  const empty = (i: number) => i === 3;
  test('the first hover on a bucket with data opens in place, with no slide', () => {
    expect(nextCardState(HIDDEN_CARD, 5, empty)).toEqual({
      visible: true,
      index: 5,
      sliding: false,
    });
  });
  test('a first hover on an empty bucket opens nothing', () => {
    expect(nextCardState(HIDDEN_CARD, 3, empty)).toEqual(HIDDEN_CARD);
  });
  test('an open card slides to the next bar, an empty one too, and never hides', () => {
    const open = { visible: true, index: 5, sliding: false };
    expect(nextCardState(open, 9, empty)).toEqual({ visible: true, index: 9, sliding: true });
    expect(nextCardState(open, 3, empty)).toEqual({ visible: true, index: 3, sliding: true });
  });
  test('leaving the chart hides it and keeps the last bucket for the fade; re-entry does not slide', () => {
    const left = nextCardState({ visible: true, index: 9, sliding: true }, null, empty);
    expect(left).toEqual({ visible: false, index: 9, sliding: false });
    expect(nextCardState(left, 2, empty)).toEqual({ visible: true, index: 2, sliding: false });
  });
});
