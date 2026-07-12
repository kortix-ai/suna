// Pure grid geometry + cell builder for KortixHyperLogo, kept free of React so
// it can be unit-tested directly and so the SSR/client renders stay in sync.

export const VIEW_W = 30;
export const VIEW_H = 25;

export const RAMP = ['░', '▒', '▓', '█'] as const;

export const COLS = 9;
export const ROWS = 8;
const CELL_W = VIEW_W / COLS;
const CELL_H = VIEW_H / ROWS;

export const CELL_FONT_SIZE = CELL_H * 1.25;

export interface Cell {
  x: number;
  y: number;
  char: string;
  threshold: number;
}

const getRandomInt = (max: number): number => Math.floor(Math.random() * max);

/**
 * Build the ASCII grid.
 *
 * `random: false` derives every cell from its index, so the result is identical
 * across calls and across server/client — this is what the component renders on
 * the server and on its first client render, preventing a hydration mismatch on
 * the (resting, invisible) cell text. `random: true` is the animated variant,
 * swapped in only on the client (on mount and on each animation trigger).
 */
export const buildCells = (random: boolean): Cell[] => {
  const cells: Cell[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      cells.push({
        x: c * CELL_W + CELL_W / 2,
        y: r * CELL_H + CELL_H / 2,
        char: random ? RAMP[getRandomInt(RAMP.length)] : RAMP[idx % RAMP.length],
        threshold: random ? Math.random() : ((idx * 7) % 11) / 11,
      });
    }
  }
  return cells;
};
