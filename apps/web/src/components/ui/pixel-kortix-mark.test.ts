import { describe, expect, test } from 'bun:test';

import { PIXEL_KORTIX_ROWS } from './pixel-kortix-mark';

describe('pixel Kortix mark', () => {
  test('every row has the same width and only known cells', () => {
    const width = PIXEL_KORTIX_ROWS[0].length;
    for (const row of PIXEL_KORTIX_ROWS) {
      expect(row.length).toBe(width);
      expect(row).toMatch(/^[#+ ]+$/);
    }
  });

  // The Kortix symbol is symmetric on both axes. A typo in one cell breaks
  // that, and it is invisible in review because the rows are just strings.
  test('mirrors left to right', () => {
    for (const row of PIXEL_KORTIX_ROWS) {
      expect(row).toBe([...row].reverse().join(''));
    }
  });

  test('mirrors top to bottom', () => {
    expect([...PIXEL_KORTIX_ROWS].reverse()).toEqual([...PIXEL_KORTIX_ROWS]);
  });
});
