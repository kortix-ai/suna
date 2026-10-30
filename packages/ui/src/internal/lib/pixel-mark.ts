/**
 * An agent's pixel mark: a 7×7 mirrored pixel figure derived from its slug.
 *
 * Same slug, same mark, on every surface and every device. Nothing is stored:
 * the slug is hashed (FNV-1a), the hash seeds a PRNG (mulberry32), the PRNG
 * fills the left half of the grid against a density mask, and the half is
 * mirrored. A draw that fails the quality gate is redrawn from a salted seed,
 * so retries stay deterministic. The tone comes from a second hash.
 *
 * Changing SIZE, MASK, the gate or PALETTES changes every agent's mark — the
 * golden test in `pixel-mark.test.ts` exists to make that a deliberate act.
 */

export const PIXEL_MARK_SIZE = 7;
const HALF = 4;
const MAX_ATTEMPTS = 256;

// Fill chance per cell, outer edge → spine. Dense centre, sparse edges, so the
// mirrored result reads as one body.
const MASK = [
  [0.15, 0.3, 0.45, 0.55],
  [0.3, 0.5, 0.6, 0.7],
  [0.4, 0.6, 0.65, 0.7],
  [0.5, 0.65, 0.7, 0.75],
  [0.4, 0.55, 0.6, 0.65],
  [0.3, 0.45, 0.5, 0.5],
  [0.2, 0.35, 0.4, 0.35],
];

export interface PixelMarkTone {
  name: string;
  tile: string;
  ink: string;
  /** Dark theme: the pair inverts, so the tile stays visible on a dark page. */
  tileDark: string;
  inkDark: string;
}

const tone = (name: string, tile: string, ink: string): PixelMarkTone => ({
  name,
  tile,
  ink,
  tileDark: ink,
  inkDark: tile,
});

export const PIXEL_MARK_TONES: readonly PixelMarkTone[] = [
  tone('graphite', '#EDEDED', '#191919'),
  tone('sand', '#F1EBDD', '#6B5A3A'),
  tone('moss', '#E6EDE0', '#3F5A33'),
  tone('sea', '#E2ECF0', '#2E5566'),
  tone('blue', '#E6EEFF', '#2457C5'),
  tone('plum', '#EEE6F0', '#5E3A68'),
  tone('clay', '#F3E6E0', '#7A4532'),
  tone('slate', '#E4E7EC', '#3B4656'),
];

/** The built-in agent and the platform's Meta agent keep the brand tile. */
const BRAND: PixelMarkTone = {
  name: 'brand',
  tile: '#1F1F1F',
  ink: '#FFFFFF',
  tileDark: '#2C2C2C',
  inkDark: '#FFFFFF',
};
const RESERVED: Record<string, PixelMarkTone> = { kortix: BRAND, meta: BRAND };

type Grid = boolean[][];

export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function draw(seed: number): Grid {
  const rand = mulberry32(seed);
  return MASK.map((row) => {
    const half = row.map((p) => rand() < p);
    return [...half, half[2], half[1], half[0]];
  });
}

function largestComponent(grid: Grid): number {
  const seen = grid.map((row) => row.map(() => false));
  let best = 0;
  for (let r = 0; r < PIXEL_MARK_SIZE; r++)
    for (let c = 0; c < PIXEL_MARK_SIZE; c++) {
      if (!grid[r][c] || seen[r][c]) continue;
      let size = 0;
      const stack: [number, number][] = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop()!;
        size++;
        for (const [ny, nx] of [[y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]]) {
          if (grid[ny]?.[nx] && !seen[ny][nx]) {
            seen[ny][nx] = true;
            stack.push([ny, nx]);
          }
        }
      }
      best = Math.max(best, size);
    }
  return best;
}

function hasIsolatedPixel(grid: Grid): boolean {
  return grid.some((row, r) =>
    row.some((on, c) => {
      if (!on) return false;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if ((dy || dx) && grid[r + dy]?.[c + dx]) return false;
      return true;
    }),
  );
}

/** Readable at 14px, fills the frame, one connected body. */
export function passesPixelMarkGate(grid: Grid): boolean {
  const filled = grid.flat().filter(Boolean).length;
  if (filled < 18 || filled > 30) return false;
  const rows = grid.filter((row) => row.some(Boolean)).length;
  const cols = grid[0].filter((_, c) => grid.some((row) => row[c])).length;
  if (rows < 5 || cols < 5) return false;
  if (grid.filter((row) => row.every(Boolean)).length > 1) return false;
  if (grid.filter((row) => row[HALF - 1]).length < 3) return false;
  if (hasIsolatedPixel(grid)) return false;
  return largestComponent(grid) >= Math.ceil(filled * 0.85);
}

/** One SVG path, horizontal runs merged. Render in `viewBox="0 0 7 7"`. */
function toPath(grid: Grid): string {
  let d = '';
  grid.forEach((row, y) => {
    for (let x = 0; x < PIXEL_MARK_SIZE; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < PIXEL_MARK_SIZE && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  });
  return d;
}

export function pixelMark(slug: string) {
  let grid = draw(fnv1a(slug));
  for (let attempt = 1; !passesPixelMarkGate(grid) && attempt < MAX_ATTEMPTS; attempt++)
    grid = draw(fnv1a(`${slug}:${attempt}`));
  const tone = RESERVED[slug] ?? PIXEL_MARK_TONES[fnv1a(`${slug}#tone`) % PIXEL_MARK_TONES.length];
  return { grid, path: toPath(grid), tone };
}
