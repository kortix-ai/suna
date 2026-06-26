import { describe, expect, test } from 'bun:test';

import { buildCells, COLS, RAMP, ROWS } from './kortix-hyper-logo.cells';

describe('buildCells', () => {
  test('builds one cell per grid position', () => {
    expect(buildCells(false)).toHaveLength(ROWS * COLS);
    expect(buildCells(true)).toHaveLength(ROWS * COLS);
  });

  test('deterministic grid is identical across calls (no hydration mismatch)', () => {
    // The server render and the first client render both use random:false, so
    // the cell text + thresholds must be byte-identical every time.
    expect(buildCells(false)).toEqual(buildCells(false));
  });

  test('deterministic grid only uses ramp glyphs and in-range thresholds', () => {
    for (const cell of buildCells(false)) {
      expect(RAMP).toContain(cell.char as (typeof RAMP)[number]);
      expect(cell.threshold).toBeGreaterThanOrEqual(0);
      expect(cell.threshold).toBeLessThanOrEqual(1);
    }
  });

  test('cell geometry is stable regardless of the random flag', () => {
    const stable = buildCells(false);
    const random = buildCells(true);
    for (let i = 0; i < stable.length; i++) {
      expect(random[i].x).toBe(stable[i].x);
      expect(random[i].y).toBe(stable[i].y);
    }
  });
});
