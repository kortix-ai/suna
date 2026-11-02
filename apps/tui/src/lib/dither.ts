/**
 * The web's dither field (`apps/web/src/features/marketing/kit/dither-field.tsx`,
 * masked in `landing/cta-section.tsx`) ported to a terminal: fbm noise flow and
 * banded light from the shader, drawn as Unicode braille dots, dense along the
 * top edge and fading out downward.
 *
 * Pure: no React, no timers. Same inputs, same dots.
 *
 * Two departures from the shader, both because a braille cell is not a pixel:
 *
 * - Threshold: a fixed random value per dot, not the 8 × 8 Bayer matrix.
 *   Bayer places the first dots of every tile on the same dot rows, and in
 *   braille those rows draw as horizontal dotted lines (`⠁ ⠁ ⠁`) wherever the
 *   field is thin, which is most of a fade. A per-dot hash keeps the field
 *   stable in time (only the level moves) and reads as soft grain.
 * - Mask: the shader multiplies the CSS mask into the alpha; a terminal cell has
 *   one color, so the falloff goes into the threshold and the field fades by
 *   dot density.
 *
 * One braille cell holds 2 × 4 dots. A terminal cell is about 1:2, so the dot
 * pitch is the same horizontally and vertically and the field is not stretched.
 */

function fract(v: number): number {
  return v - Math.floor(v);
}

function hash(x: number, y: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Four octaves of value noise, the shader's `fbm`, at (`x + t`, `y + t`). */
export function fbm(x: number, y: number, t = 0): number {
  let px = x + t;
  let py = y + t;
  let v = 0;
  let a = 0.5;
  for (let i = 0; i < 4; i += 1) {
    v += a * noise(px, py);
    const nx = px * 2.03 + 4.1;
    py = py * 2.03 + 1.7;
    px = nx;
    a *= 0.5;
  }
  return v;
}

export interface DitherBandOptions {
  /** Dots per field unit. Fixed, so the texture does not change with width. Default 20. */
  scale?: number;
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** A fixed threshold in [0, 1) per dot. */
function grain(x: number, y: number): number {
  return fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
}

/**
 * Fill a `width × height` dot grid (row-major, 1 = dot) with the field at time
 * `t` (seconds). The falloff is `(1 − y / 0.9h)^1.8` from the top edge, so the
 * bottom tenth is empty and the field ends in the background, times a gentle
 * side fade (35 % thinner at the left and right edges), like the CTA's linear
 * plus radial mask. The shader's flow and bands modulate the density, and the
 * field drifts at its speed (`t · 0.06`).
 */
export function ditherBand(
  width: number,
  height: number,
  t: number,
  options: DitherBandOptions = {},
): Uint8Array {
  const scale = options.scale ?? 20;
  const dots = new Uint8Array(Math.max(width, 0) * Math.max(height, 0));
  if (width <= 0 || height <= 0) return dots;
  const time = t * 0.06;
  const halfW = width / 2;
  for (let y = 0; y < height; y += 1) {
    const fall = Math.max(0, 1 - y / (height * 0.9)) ** 1.8;
    if (fall === 0) continue;
    const py = y / scale;
    const sy = py * 2.4;
    for (let x = 0; x < width; x += 1) {
      const rx = (x - halfW) / halfW;
      const sx = (x / scale) * 1.6 + time;
      // `fbm(surface + vec2(fbm(surface * 1.5 + t), 0.0))`
      const flow = fbm(sx + fbm(sx * 1.5, sy * 1.5, time), sy);
      const bands = 0.5 + 0.5 * Math.sin(py * 18 + flow * 8);
      const level =
        fall * (1 - 0.35 * rx * rx) * Math.min(1, mix(0.3, 1.15, bands) * mix(0.7, 1.15, flow));
      if (grain(x, y) < level) dots[y * width + x] = 1;
    }
  }
  return dots;
}

/** Braille dot bits, `[dy][dx]` inside one 2 × 4 cell (Unicode order). */
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

/** Braille bits (0–255) of the 2 × 4 cell at (`col`, `row`) of a dot grid
 *  `width` dots wide. Dots past the grid's end read as empty. */
export function brailleBitsAt(dots: Uint8Array, width: number, col: number, row: number): number {
  let bits = 0;
  for (let dy = 0; dy < 4; dy += 1) {
    const base = (row * 4 + dy) * width + col * 2;
    if (dots[base]) bits |= BRAILLE_BITS[dy][0];
    if (col * 2 + 1 < width && dots[base + 1]) bits |= BRAILLE_BITS[dy][1];
  }
  return bits;
}

/** The braille character for `bits`; a space for 0, not U+2800: some fonts
 *  draw the blank braille cell as faint circles. */
export function brailleChar(bits: number): string {
  return bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits);
}

/** Pack a dot grid `cols * 2` wide and `rows * 4` tall into `rows` strings of
 *  `cols` braille characters (U+2800 + bits). */
export function toBraille(dots: Uint8Array, cols: number, rows: number): string[] {
  const out: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    let line = '';
    for (let col = 0; col < cols; col += 1)
      line += brailleChar(brailleBitsAt(dots, cols * 2, col, row));
    out.push(line);
  }
  return out;
}
