/**
 * Conway's Game of Life for the splash: the Kortix symbol is the first
 * generation, the way the web's `/game-of-life` page seeds its grid from the
 * logo (`apps/web/src/app/[locale]/game-of-life/game-of-life.tsx`).
 *
 * Pure: no React, no timers. The splash owns the clock.
 *
 * - Rules: B3/S23 (a dead cell with 3 live neighbours is born; a live cell with
 *   2 or 3 survives).
 * - Edges: toroidal, like the web page. A glider that leaves the bottom comes
 *   back at the top, so the splash area never loses its pattern to the border.
 * - Rendering: `toQuadrantRuns`, 2 × 2 cells per terminal cell in quadrant
 *   blocks — the glyph family the resting symbol is drawn in (`█` is a full
 *   quadrant). The splash draws the resting symbol with the same seed
 *   (`seedQuadrants`) and the same renderer, so generation 0 is the symbol,
 *   glyph for glyph, on the same columns.
 * - The solid symbol collapses into still lifes after ~20 generations at this
 *   resolution (measured). Like the web page, the splash then `sprinkle`s 1 %
 *   live cells and goes on; the rule is never changed.
 */

import { brailleBitsAt, brailleChar } from './dither.ts';

export interface LifeGrid {
  width: number;
  height: number;
  /** Row-major, non-zero = alive. `cells[y * width + x]`. A seed holds tones (1, 2). */
  cells: Uint8Array;
}

export function emptyGrid(width: number, height: number): LifeGrid {
  return { width, height, cells: new Uint8Array(Math.max(width, 0) * Math.max(height, 0)) };
}

export function isAlive(grid: LifeGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
  return grid.cells[y * grid.width + x] !== 0;
}

/** Live cells. */
export function population(grid: LifeGrid): number {
  let count = 0;
  for (const cell of grid.cells) if (cell !== 0) count += 1;
  return count;
}

/** One generation, B3/S23 on a torus. Any non-zero cell is alive (a seed
 *  carries tones); the result holds 0 and 1 only. Returns a new grid. */
export function step(grid: LifeGrid): LifeGrid {
  const { width: w, height: h } = grid;
  const cells = grid.cells.some((cell) => cell > 1)
    ? grid.cells.map((cell) => (cell ? 1 : 0))
    : grid.cells;
  const next = new Uint8Array(cells.length);
  if (w === 0 || h === 0) return { width: w, height: h, cells: next };
  for (let y = 0; y < h; y += 1) {
    const up = ((y + h - 1) % h) * w;
    const mid = y * w;
    const down = ((y + 1) % h) * w;
    for (let x = 0; x < w; x += 1) {
      const left = (x + w - 1) % w;
      const right = (x + 1) % w;
      const n =
        cells[up + left] +
        cells[up + x] +
        cells[up + right] +
        cells[mid + left] +
        cells[mid + right] +
        cells[down + left] +
        cells[down + x] +
        cells[down + right];
      const alive = cells[mid + x] === 1;
      next[mid + x] = n === 3 || (alive && n === 2) ? 1 : 0;
    }
  }
  return { width: w, height: h, cells: next };
}

/** FNV-1a over the cells: equal grids hash equal. */
export function gridHash(grid: LifeGrid): number {
  let h = 0x811c9dc5;
  for (const cell of grid.cells) {
    h ^= cell;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface LifeSnapshot {
  hash: number;
  population: number;
}

export function snapshot(grid: LifeGrid): LifeSnapshot {
  return { hash: gridHash(grid), population: population(grid) };
}

/** Generations of flat population after which a run counts as settled. */
export const POPULATION_WINDOW = 36;

/**
 * True when the run has settled, from the snapshots of every generation so far
 * (oldest first):
 *
 * - the grid is empty, did not change, or repeats with period 2 (blinkers);
 * - or the population has repeated with a period of at most 4 for the last
 *   `POPULATION_WINDOW` generations. That catches what the grid hash cannot:
 *   a glider circling the torus among still lifes changes the grid every
 *   generation but never the count. The web page uses the same signal (an
 *   unchanged live count).
 */
export function isStagnant(history: readonly LifeSnapshot[]): boolean {
  const n = history.length;
  if (n === 0) return false;
  const last = history[n - 1];
  if (last.population === 0) return true;
  if (n >= 2 && history[n - 2].hash === last.hash) return true;
  if (n >= 3 && history[n - 3].hash === last.hash) return true;
  if (n < POPULATION_WINDOW + 4) return false;
  for (let period = 1; period <= 4; period += 1) {
    let repeats = true;
    for (let i = n - POPULATION_WINDOW; i < n; i += 1) {
      if (history[i].population !== history[i - period].population) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

/**
 * Move `grid` toward `target`: every pixel that differs takes the target value
 * with probability `fraction` (0–1). `fraction` 1 returns the target exactly.
 * The splash calls it with a rising fraction, so the run dissolves back into
 * the symbol. `random` is injectable for tests.
 */
export function morphToward(
  grid: LifeGrid,
  target: LifeGrid,
  fraction: number,
  random: () => number = Math.random,
): LifeGrid {
  if (fraction >= 1)
    return { width: target.width, height: target.height, cells: target.cells.slice() };
  const cells = grid.cells.slice();
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i] !== target.cells[i] && random() < fraction) cells[i] = target.cells[i];
  }
  return { width: grid.width, height: grid.height, cells };
}

/**
 * Seed the symbol onto a Life grid cell by cell, at exactly where the resting
 * splash draws it — a quadrant grid (2 × 2 Life cells per terminal cell) for
 * the resting glyphs, a braille grid (2 × 4) for Life itself. A symbol cell is
 * `cellW` × `cellH` Life cells and its top-left is (`x0` + cx·cellW,
 * `y0` + cy·cellH). At 2× the resting symbol draws a cell as `██` (two
 * columns, one row): 4 × 2 quadrant cells, or 4 × 4 braille dots. Tones: 2 for
 * `#`, 1 for `+`; `step` reads both as alive.
 */
export function seedCells(
  rows: readonly string[],
  gridW: number,
  gridH: number,
  x0: number,
  y0: number,
  cellW: number,
  cellH: number,
): LifeGrid {
  const grid = emptyGrid(gridW, gridH);
  rows.forEach((row, cy) => {
    [...row].forEach((cell, cx) => {
      if (cell === ' ') return;
      const tone = cell === '+' ? 1 : 2;
      for (let dy = 0; dy < cellH; dy += 1) {
        for (let dx = 0; dx < cellW; dx += 1) {
          const x = x0 + cx * cellW + dx;
          const y = y0 + cy * cellH + dy;
          if (x >= 0 && y >= 0 && x < gridW && y < gridH) grid.cells[y * gridW + x] = tone;
        }
      }
    });
  });
  return grid;
}

/** Quadrant block per 4-bit mask: top-left 1, top-right 2, bottom-left 4, bottom-right 8. */
export const QUADRANTS = [
  ' ',
  '▘',
  '▝',
  '▀',
  '▖',
  '▌',
  '▞',
  '▛',
  '▗',
  '▚',
  '▐',
  '▜',
  '▄',
  '▙',
  '▟',
  '█',
] as const;

export interface ToneRun {
  text: string;
  /** `full`: a `#` seed cell or a cell born this generation. `half`: the rest. */
  tone: 'full' | 'half';
}

/**
 * The grid as quadrant blocks, one run list per terminal row. Same glyph
 * family as the resting symbol (`█` is a full quadrant), so generation 0 is
 * the symbol, glyph for glyph and column for column. A character is `full`
 * when it holds a `#` seed cell (tone 2) or a newborn cell (alive here, dead
 * in `previous`); otherwise `half`. Blank characters join the current run.
 */
export function toQuadrantRuns(grid: LifeGrid, previous?: LifeGrid): ToneRun[][] {
  const out: ToneRun[][] = [];
  const cols = Math.ceil(grid.width / 2);
  for (let row = 0; row < Math.ceil(grid.height / 2); row += 1) {
    const runs: ToneRun[] = [];
    for (let col = 0; col < cols; col += 1) {
      let mask = 0;
      let full = false;
      for (let bit = 0; bit < 4; bit += 1) {
        const x = col * 2 + (bit & 1);
        const y = row * 2 + (bit >> 1);
        if (x >= grid.width || y >= grid.height) continue;
        const value = grid.cells[y * grid.width + x] ?? 0;
        if (!value) continue;
        mask |= 1 << bit;
        if (value === 2 || (previous && !previous.cells[y * grid.width + x])) full = true;
      }
      const glyph = QUADRANTS[mask] ?? ' ';
      const tone: ToneRun['tone'] = full ? 'full' : 'half';
      const last = runs.at(-1);
      if (last && (mask === 0 || last.tone === tone)) last.text += glyph;
      else runs.push({ text: glyph, tone });
    }
    out.push(runs);
  }
  return out;
}

/**
 * Turn `fraction` of the cells alive at random — what the web's
 * `/game-of-life` page does when the board goes stagnant. It changes the
 * STATE between generations, never the rule: `step` stays B3/S23. The splash
 * uses it because the solid symbol collapses into still lifes after ~20
 * generations at quadrant resolution (measured on 80×20, 120×30, 138×34).
 */
export function sprinkle(
  grid: LifeGrid,
  fraction: number,
  random: () => number = Math.random,
): LifeGrid {
  const cells = grid.cells.slice();
  const count = Math.floor(cells.length * fraction);
  for (let i = 0; i < count; i += 1) cells[Math.floor(random() * cells.length)] = 1;
  return { width: grid.width, height: grid.height, cells };
}

/**
 * The grid as braille, 2 × 4 Life cells per terminal cell, one run list per
 * terminal row — fine enough that the symbol evolves for ~250 generations
 * before it settles, where the quadrant grid settles in ~20 (measured). A
 * character is `full` when it holds a `#` seed cell (tone 2) or a cell born
 * this generation (dead in `previous`); otherwise `half`. Blank characters
 * join the current run.
 */
export function toBrailleRuns(grid: LifeGrid, previous?: LifeGrid): ToneRun[][] {
  const out: ToneRun[][] = [];
  const cols = Math.ceil(grid.width / 2);
  for (let row = 0; row < Math.ceil(grid.height / 4); row += 1) {
    const runs: ToneRun[] = [];
    for (let col = 0; col < cols; col += 1) {
      const glyph = brailleChar(brailleBitsAt(grid.cells, grid.width, col, row));
      let full = false;
      for (let dy = 0; dy < 4 && !full; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const x = col * 2 + dx;
          const y = row * 4 + dy;
          if (x >= grid.width || y >= grid.height) continue;
          const value = grid.cells[y * grid.width + x] ?? 0;
          if (value === 2 || (value && previous && !previous.cells[y * grid.width + x]))
            full = true;
        }
      }
      const tone: ToneRun['tone'] = full ? 'full' : 'half';
      const last = runs.at(-1);
      if (last && (glyph === ' ' || last.tone === tone)) last.text += glyph;
      else runs.push({ text: glyph, tone });
    }
    out.push(runs);
  }
  return out;
}
