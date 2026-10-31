import { describe, expect, test } from 'bun:test';

import { PIXEL_KORTIX_ROWS } from '@kortix/shared/pixel-mark';

import {
  type LifeGrid,
  type LifeSnapshot,
  POPULATION_WINDOW,
  emptyGrid,
  isAlive,
  isStagnant,
  morphToward,
  population,
  snapshot,
  QUADRANTS,
  seedCells,
  sprinkle,
  step,
  toQuadrantRuns,
} from './life.ts';

function gridOf(rows: readonly string[]): LifeGrid {
  const grid = emptyGrid(rows[0].length, rows.length);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => (grid.cells[y * grid.width + x] = c === '#' ? 1 : 0)),
  );
  return grid;
}

function rowsOf(grid: LifeGrid): string[] {
  const rows: string[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    let row = '';
    for (let x = 0; x < grid.width; x += 1) row += isAlive(grid, x, y) ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

describe('step (B3/S23, toroidal)', () => {
  test('a blinker oscillates with period 2', () => {
    const horizontal = gridOf(['.....', '.....', '.###.', '.....', '.....']);
    const vertical = step(horizontal);
    expect(rowsOf(vertical)).toEqual(['.....', '..#..', '..#..', '..#..', '.....']);
    expect(rowsOf(step(vertical))).toEqual(rowsOf(horizontal));
  });

  test('a block is stable', () => {
    const block = gridOf(['....', '.##.', '.##.', '....']);
    expect(rowsOf(step(block))).toEqual(rowsOf(block));
  });

  test('a glider moves one cell down-right every 4 generations', () => {
    let grid = gridOf([
      '.#......',
      '..#.....',
      '###.....',
      '........',
      '........',
      '........',
      '........',
      '........',
    ]);
    for (let i = 0; i < 4; i += 1) grid = step(grid);
    expect(rowsOf(grid)).toEqual([
      '........',
      '..#.....',
      '...#....',
      '.###....',
      '........',
      '........',
      '........',
      '........',
    ]);
  });

  test('edges wrap: a blinker across the left/right edge still oscillates', () => {
    const wrapped = gridOf(['.....', '.....', '##..#', '.....', '.....']);
    expect(rowsOf(step(wrapped))).toEqual(['.....', '#....', '#....', '#....', '.....']);
  });
});

describe('isStagnant', () => {
  const snap = (hash: number, pop: number): LifeSnapshot => ({ hash, population: pop });

  test('an empty grid, a still life and a period-2 oscillator are stagnant', () => {
    expect(isStagnant([snapshot(emptyGrid(4, 4))])).toBe(true);
    const block = gridOf(['....', '.##.', '.##.', '....']);
    expect(isStagnant([snapshot(block), snapshot(step(block))])).toBe(true);
    const blinker = gridOf(['.....', '.....', '.###.', '.....', '.....']);
    const history = [blinker, step(blinker), step(step(blinker))].map(snapshot);
    expect(isStagnant(history.slice(0, 2))).toBe(false);
    expect(isStagnant(history)).toBe(true);
  });

  test('a glider circling a torus settles by its flat population', () => {
    let grid = gridOf([
      '.#......',
      '..#.....',
      '###.....',
      '........',
      '........',
      '........',
      '........',
      '........',
    ]);
    const history = [snapshot(grid)];
    let settledAt = -1;
    for (let gen = 1; gen <= 80 && settledAt < 0; gen += 1) {
      grid = step(grid);
      history.push(snapshot(grid));
      if (isStagnant(history)) settledAt = gen;
    }
    expect(settledAt).toBe(POPULATION_WINDOW + 3);
  });

  test('a changing population is not stagnant', () => {
    const history = Array.from({ length: 60 }, (_, i) => snap(i, 10 + (i % 7)));
    expect(isStagnant(history)).toBe(false);
  });
});

describe('morphToward', () => {
  test('fraction 0 keeps the grid, fraction 1 returns the target', () => {
    const grid = gridOf(['#..', '...', '..#']);
    const target = gridOf(['.#.', '.#.', '.#.']);
    expect(rowsOf(morphToward(grid, target, 0, () => 0.5))).toEqual(rowsOf(grid));
    expect(rowsOf(morphToward(grid, target, 1))).toEqual(rowsOf(target));
  });

  test('a pixel flips when the draw falls under the fraction', () => {
    const grid = gridOf(['#.']);
    const target = gridOf(['.#']);
    const draws = [0.1, 0.9];
    expect(rowsOf(morphToward(grid, target, 0.5, () => draws.shift() ?? 1))).toEqual(['..']);
  });
});

describe('B3/S23, checked against a naive reference', () => {
  /** The rules written out the slow, obvious way: count 8 neighbours on a torus. */
  function reference(cells: number[][]): number[][] {
    const h = cells.length;
    const w = cells[0]?.length ?? 0;
    return cells.map((row, y) =>
      row.map((cell, x) => {
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            n += cells[(y + dy + h) % h]?.[(x + dx + w) % w] ? 1 : 0;
          }
        }
        // Born with exactly 3; survives with 2 or 3; otherwise dead.
        return (cell ? n === 2 || n === 3 : n === 3) ? 1 : 0;
      }),
    );
  }

  test('200 random grids, 8 generations each, match the reference cell for cell', () => {
    let seed = 0x2545f491;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const w = 3 + Math.floor(random() * 14);
      const h = 3 + Math.floor(random() * 10);
      let expected: number[][] = Array.from({ length: h }, () =>
        Array.from({ length: w }, () => (random() < 0.35 ? 1 : 0)),
      );
      let grid = emptyGrid(w, h);
      expected.forEach((row, y) => row.forEach((cell, x) => (grid.cells[y * w + x] = cell)));
      for (let generation = 0; generation < 8; generation += 1) {
        expected = reference(expected);
        grid = step(grid);
        expect(Array.from(grid.cells)).toEqual(expected.flat());
      }
    }
  });

  test('a beehive is still and a toad has period 2', () => {
    const beehive = emptyGrid(6, 5);
    for (const [x, y] of [
      [2, 1],
      [3, 1],
      [1, 2],
      [4, 2],
      [2, 3],
      [3, 3],
    ])
      beehive.cells[y * 6 + x] = 1;
    expect(Array.from(step(beehive).cells)).toEqual(Array.from(beehive.cells));

    const toad = emptyGrid(6, 6);
    for (const [x, y] of [
      [2, 2],
      [3, 2],
      [4, 2],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
      toad.cells[y * 6 + x] = 1;
    const once = step(toad);
    expect(Array.from(once.cells)).not.toEqual(Array.from(toad.cells));
    expect(Array.from(step(once).cells)).toEqual(Array.from(toad.cells));
  });
});

describe('quadrant rendering', () => {
  test('a 2× symbol cell is `██`, `+` cells are the half tone, and both join runs by tone', () => {
    const grid = seedCells(['#+', '  '], 8, 4, 0, 0, 4, 2);
    expect(toQuadrantRuns(grid)[0]).toEqual([
      { text: '██', tone: 'full' },
      { text: '██', tone: 'half' },
    ]);
  });

  test('every 2 × 2 mask maps to its quadrant glyph', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const grid = emptyGrid(2, 2);
      for (let bit = 0; bit < 4; bit += 1)
        if (mask & (1 << bit)) grid.cells[(bit >> 1) * 2 + (bit & 1)] = 1;
      expect(
        toQuadrantRuns(grid)[0]
          ?.map((run) => run.text)
          .join(''),
      ).toBe(QUADRANTS[mask]);
    }
  });
});

describe('sprinkle', () => {
  test('turns the given share of cells alive and leaves the rule alone', () => {
    let i = 0;
    const draws = [0.1, 0.5, 0.9];
    const grid = sprinkle(emptyGrid(10, 10), 0.03, () => draws[i++ % draws.length] as number);
    expect(population(grid)).toBe(3);
    expect(Array.from(step(step(grid)).cells).every((cell) => cell === 0 || cell === 1)).toBe(true);
  });
});
