import { describe, expect, test } from 'bun:test';

import { orderedListGutter, orderedListMarkerDigits } from './ordered-list';

describe('orderedListMarkerDigits', () => {
  test('counts the widest ordinal a default list paints', () => {
    expect(orderedListMarkerDigits({ itemCount: 9 })).toBe(1);
    expect(orderedListMarkerDigits({ itemCount: 10 })).toBe(2);
    expect(orderedListMarkerDigits({ itemCount: 100 })).toBe(3);
  });

  test('offsets the count by the start ordinal', () => {
    expect(orderedListMarkerDigits({ start: 8, itemCount: 2 })).toBe(1);
    expect(orderedListMarkerDigits({ start: 8, itemCount: 3 })).toBe(2);
    expect(orderedListMarkerDigits({ start: 98, itemCount: 3 })).toBe(3);
  });

  test('a reversed list counts down from its start', () => {
    expect(orderedListMarkerDigits({ start: 10, itemCount: 3, reversed: true })).toBe(2);
    expect(orderedListMarkerDigits({ itemCount: 12, reversed: true })).toBe(2);
  });

  test('counts a minus sign as a character', () => {
    expect(orderedListMarkerDigits({ start: -12, itemCount: 2 })).toBe(3);
  });

  test('an empty list still reserves one digit', () => {
    expect(orderedListMarkerDigits({ itemCount: 0 })).toBe(1);
  });
});

describe('orderedListGutter', () => {
  test('one digit is exactly the pl-6 scale step', () => {
    expect(orderedListGutter(1)).toBe('calc(var(--spacing) * 6 + 0ch)');
  });

  test('every extra digit widens the gutter by one tabular digit', () => {
    expect(orderedListGutter(2)).toBe('calc(var(--spacing) * 6 + 1ch)');
    expect(orderedListGutter(3)).toBe('calc(var(--spacing) * 6 + 2ch)');
  });
});
