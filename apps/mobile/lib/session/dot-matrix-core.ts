/**
 * Dot-matrix engine — a React-free port of apps/web
 * `lib/dotmatrix-core.tsx`, `lib/dotmatrix-hooks.ts`, and
 * `components/dotmatrix-loader.css`.
 *
 * Web draws each dot as a `<span>` whose opacity comes from one of two places:
 * an inline style computed by a resolver (JS phase from `useCyclePhase` /
 * `useSteppedCycle`), or a CSS keyframe animation with a per-dot
 * `animation-delay`. React Native has neither CSS animations nor custom
 * properties, so this module evaluates BOTH as pure functions of elapsed time:
 * a variant is `frame(elapsedMs, still) → opacity per cell`. The CSS side keeps
 * the stylesheet's semantics — keyframe offsets (last duplicate wins), the
 * timing function applied per keyframe interval, and the resting
 * `.dmx-dot` opacity while a dot waits out its delay.
 *
 * No React / React Native import. Pinned by `dot-matrix.test.ts`.
 */

// ─── Grid geometry ───────────────────────────────────────────────────────────

export type GridSize = 3 | 5;

export interface DotCell {
  index: number;
  row: number;
  col: number;
  distanceFromCenter: number;
  angleFromCenter: number;
  radiusNormalized: number;
  manhattanDistance: number;
}

function buildCells(n: GridSize): readonly DotCell[] {
  const center = Math.floor(n / 2);
  const maxRadius = Math.hypot(center, center);
  const cells: DotCell[] = [];
  for (let index = 0; index < n * n; index += 1) {
    const row = Math.floor(index / n);
    const col = index % n;
    const distance = Math.hypot(row - center, col - center);
    cells.push({
      index,
      row,
      col,
      distanceFromCenter: distance,
      angleFromCenter: Math.atan2(row - center, col - center),
      radiusNormalized: distance / maxRadius,
      manhattanDistance: Math.abs(row - center) + Math.abs(col - center),
    });
  }
  return cells;
}

export const CELLS_5 = buildCells(5);
export const CELLS_3 = buildCells(3);

export function rowMajorIndex(row: number, col: number): number {
  return row * 5 + col;
}

export function rowMajorIndex3(row: number, col: number): number {
  return row * 3 + col;
}

const CORNER_COORDS = new Set(['0,0', '0,4', '4,0', '4,4']);

export function isWithinCircularMask(row: number, col: number): boolean {
  return !CORNER_COORDS.has(`${row},${col}`);
}

// ─── 5×5 path orders ─────────────────────────────────────────────────────────

const N = 5;
const CELLS = N * N;

export function trBlPathNormFromIndex(index: number): number {
  const row = Math.floor(index / N);
  const col = index % N;
  return (row + (N - 1 - col)) / ((N - 1) * 2);
}

const SPIRAL_INWARD_ORDER: readonly number[] = (() => {
  const order = new Array<number>(CELLS);
  let top = 0;
  let bottom = N - 1;
  let left = 0;
  let right = N - 1;
  let t = 0;
  while (top <= bottom && left <= right) {
    for (let col = left; col <= right; col += 1) order[rowMajorIndex(top, col)] = t++;
    for (let row = top + 1; row <= bottom; row += 1) order[rowMajorIndex(row, right)] = t++;
    if (top < bottom) for (let col = right - 1; col >= left; col -= 1) order[rowMajorIndex(bottom, col)] = t++;
    if (left < right) for (let row = bottom - 1; row > top; row -= 1) order[rowMajorIndex(row, left)] = t++;
    top += 1;
    bottom -= 1;
    left += 1;
    right -= 1;
  }
  return order;
})();

export function spiralInwardOrderValue(index: number): number {
  return SPIRAL_INWARD_ORDER[index]!;
}

export function spiralInwardNormFromIndex(index: number): number {
  return SPIRAL_INWARD_ORDER[index]! / (CELLS - 1);
}

function orderFromCoords(coords: ReadonlyArray<readonly [number, number]>, size: number): number[] {
  const order = new Array<number>(size * size).fill(-1);
  coords.forEach(([row, col], t) => {
    order[row * size + col] = t;
  });
  return order;
}

const OUTER_RING_CLOCKWISE_ORDER = orderFromCoords(
  [
    [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 4], [2, 4], [3, 4],
    [4, 4], [4, 3], [4, 2], [4, 1], [4, 0], [3, 0], [2, 0], [1, 0],
  ],
  5,
);

const MIDDLE_RING_ANTI_CLOCKWISE_ORDER = orderFromCoords(
  [[1, 1], [2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [1, 2]],
  5,
);

export function outerRingClockwiseOrderValue(index: number): number {
  return OUTER_RING_CLOCKWISE_ORDER[index]!;
}

export function outerRingClockwiseNormFromIndex(index: number): number {
  const order = OUTER_RING_CLOCKWISE_ORDER[index]!;
  return order >= 0 ? order / 15 : 0;
}

export function middleRingAntiClockwiseOrderValue(index: number): number {
  return MIDDLE_RING_ANTI_CLOCKWISE_ORDER[index]!;
}

export function middleRingAntiClockwiseNormFromIndex(index: number): number {
  const order = MIDDLE_RING_ANTI_CLOCKWISE_ORDER[index]!;
  return order >= 0 ? order / 7 : 0;
}

const DIAGONAL_SNAKE_ORDER: readonly number[] = (() => {
  const order = new Array<number>(CELLS);
  let t = 0;
  for (let diagonal = 0; diagonal <= (N - 1) * 2; diagonal += 1) {
    const rowStart = Math.max(0, diagonal - (N - 1));
    const rowEnd = Math.min(N - 1, diagonal);
    if (diagonal % 2 === 0) {
      for (let row = rowEnd; row >= rowStart; row -= 1) order[rowMajorIndex(row, diagonal - row)] = t++;
    } else {
      for (let row = rowStart; row <= rowEnd; row += 1) order[rowMajorIndex(row, diagonal - row)] = t++;
    }
  }
  return order;
})();

export function diagonalSnakeOrderValue(index: number): number {
  return DIAGONAL_SNAKE_ORDER[index]!;
}

export function diagonalSnakeNormFromIndex(index: number): number {
  return DIAGONAL_SNAKE_ORDER[index]! / (CELLS - 1);
}

// ─── 3×3 path orders ─────────────────────────────────────────────────────────

export type DiagonalWave3Direction = 'tr-bl' | 'tl-br' | 'br-tl' | 'bl-tr';

export function diagonalWave3PathNormFromIndex(index: number, direction: DiagonalWave3Direction): number {
  const row = Math.floor(index / 3);
  const col = index % 3;
  switch (direction) {
    case 'tr-bl':
      return (row + (2 - col)) / 4;
    case 'tl-br':
      return (row + col) / 4;
    case 'br-tl':
      return (4 - row - col) / 4;
    case 'bl-tr':
      return (4 - row - (2 - col)) / 4;
  }
}

const SNAKE_ORDER_3: readonly number[] = [0, 1, 2, 5, 4, 3, 6, 7, 8];

export function snakePath3OrderValue(index: number): number {
  return SNAKE_ORDER_3[index]!;
}

export function snakePath3NormFromIndex(index: number): number {
  return SNAKE_ORDER_3[index]! / 8;
}

const OUTER_RING_CLOCKWISE_ORDER_3 = orderFromCoords(
  [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [1, 0]],
  3,
);

export function outerRingClockwise3OrderValue(index: number): number {
  return OUTER_RING_CLOCKWISE_ORDER_3[index]!;
}

export function outerRingClockwise3NormFromIndex(index: number): number {
  const order = OUTER_RING_CLOCKWISE_ORDER_3[index]!;
  return order < 0 ? 0 : order / 7;
}

export function wave3PathOpacityFromNorm(norm: number, base = 0.06, mid = 0.38, peak = 0.88): number {
  const t = Math.min(1, Math.max(0, norm));
  if (t <= 0.5) return base + (t / 0.5) * (mid - base);
  return mid + ((t - 0.5) / 0.5) * (peak - mid);
}

// ─── Glyph spin (3×3) ────────────────────────────────────────────────────────

export const GLYPH_SPIN_CYCLE_MS_BASE = 180 * 4;

export function rotate3x3(pattern: readonly number[], turns: number): readonly number[] {
  const t = ((turns % 4) + 4) % 4;
  let out = [...pattern];
  for (let k = 0; k < t; k += 1) {
    const next = new Array<number>(9).fill(0);
    for (let i = 0; i < 9; i += 1) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      next[c * 3 + (2 - r)] = out[i]!;
    }
    out = next;
  }
  return out;
}

export function glyphSpinOpacity(
  current: readonly number[],
  next: readonly number[],
  index: number,
  t: number,
): number {
  const weight = (current[index] ?? 0) * (1 - t) + (next[index] ?? 0) * t;
  return 0.09 + weight * (0.88 - 0.09);
}

export function glyphSpinSmoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

// ─── Opacity remap ───────────────────────────────────────────────────────────

const SOURCE_BASE_OPACITY = 0.08;
const SOURCE_MID_OPACITY = 0.34;
const SOURCE_PEAK_OPACITY = 0.94;

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function progressBetween(value: number, start: number, end: number): number {
  const span = end - start;
  if (Math.abs(span) < Number.EPSILON) return 0;
  return Math.min(1, Math.max(0, (value - start) / span));
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Web `remapOpacityToTriplet` for the one override the session pool uses:
 * `opacityBase` (the 3×3 base passes 0.06; the 5×5 base passes nothing, which
 * only clamps).
 */
export function remapOpacityToTriplet(opacity: number, opacityBase: number | undefined): number {
  if (!Number.isFinite(opacity)) return opacity;
  const safe = clamp01(opacity);
  if (opacityBase === undefined) return safe;
  const targetBase = clamp01(opacityBase);
  if (safe <= SOURCE_BASE_OPACITY) return clamp01(lerp(0, targetBase, progressBetween(safe, 0, SOURCE_BASE_OPACITY)));
  if (safe <= SOURCE_MID_OPACITY) {
    return clamp01(lerp(targetBase, SOURCE_MID_OPACITY, progressBetween(safe, SOURCE_BASE_OPACITY, SOURCE_MID_OPACITY)));
  }
  if (safe <= SOURCE_PEAK_OPACITY) {
    return clamp01(
      lerp(SOURCE_MID_OPACITY, SOURCE_PEAK_OPACITY, progressBetween(safe, SOURCE_MID_OPACITY, SOURCE_PEAK_OPACITY)),
    );
  }
  return clamp01(lerp(SOURCE_PEAK_OPACITY, 1, progressBetween(safe, SOURCE_PEAK_OPACITY, 1)));
}

// ─── Phase hooks, as functions of time ───────────────────────────────────────

/** Web `useCyclePhase`: 0 → 1 over `cycleMsBase / speed`, 0 when inactive. */
export function cyclePhase(elapsedMs: number, active: boolean, cycleMsBase: number, speed: number): number {
  if (!active) return 0;
  const safeSpeed = speed > 0 ? speed : 1;
  const raw = cycleMsBase / safeSpeed;
  const cycleMs = raw > 0 && Number.isFinite(raw) ? raw : 1000;
  return (((elapsedMs % cycleMs) + cycleMs) % cycleMs) / cycleMs;
}

/** Web `useSteppedCycle`: the integer step, `idleStep` when inactive. */
export function steppedCycle(
  elapsedMs: number,
  active: boolean,
  cycleMsBase: number,
  steps: number,
  speed: number,
  idleStep = 0,
): number {
  if (!active) return idleStep;
  const safeSteps = Math.max(1, Math.floor(steps));
  const stepMs = steppedCycleStepMs(cycleMsBase, steps, speed);
  const cycleMs = stepMs * safeSteps;
  return Math.floor((Math.max(0, elapsedMs) % cycleMs) / stepMs) % safeSteps;
}

export function steppedCycleStepMs(cycleMsBase: number, steps: number, speed: number): number {
  const safeSteps = Math.max(1, Math.floor(steps));
  const safeSpeed = speed > 0 ? speed : 1;
  const raw = cycleMsBase / safeSpeed / safeSteps;
  return raw > 0 && Number.isFinite(raw) ? raw : 1;
}

// ─── CSS keyframes ───────────────────────────────────────────────────────────

/** `--dmx-cycle` for both grids. */
export const DMX_CYCLE_MS = 1500;

/** `--dmx-opacity-base/mid/peak` as the dot sees them. */
export interface OpacityVars {
  base: number;
  mid: number;
  peak: number;
}

/** `.dmx-root` defaults; the 5×5 base sets no override. */
export const VARS_5: OpacityVars = { base: 0.16, mid: 0.32, peak: 1 };
/** `DotMatrix3Base` sets `--dmx-opacity-base: 0.06`. */
export const VARS_3: OpacityVars = { base: 0.06, mid: 0.32, peak: 1 };

/** `.dmx-dot { opacity: calc(0.5 * (base + mid)) }` — shown before an animation starts. */
export function restingOpacity(vars: OpacityVars): number {
  return 0.5 * (vars.base + vars.mid);
}

export type Easing = (u: number) => number;

/** CSS `cubic-bezier(x1, y1, x2, y2)`. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-7) return sampleY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i += 1) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-7) break;
      if (value < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);
export const EASE_OUT = cubicBezier(0, 0, 0.58, 1);
export const LINEAR: Easing = (u) => u;

/** CSS `steps(n, end)`. */
export function stepsEnd(n: number): Easing {
  return (u) => (u >= 1 ? 1 : Math.floor(u * n) / n);
}

type KeyframeValue = (vars: OpacityVars) => number;

/** One `@keyframes` rule block: every offset (0–100) in its selector list, one value. */
export type KeyframeBlock = readonly [readonly number[], KeyframeValue];

export interface CssAnimation {
  /** `animation-duration` at speed 1, ms. */
  durationMs: number;
  timing: Easing;
  /** Sorted `[offset 0–1, value]`, duplicates resolved (last declaration wins). */
  keyframes: ReadonlyArray<readonly [number, KeyframeValue]>;
}

export function cssAnimation(durationMs: number, timing: Easing, blocks: readonly KeyframeBlock[]): CssAnimation {
  const byOffset = new Map<number, KeyframeValue>();
  for (const [offsets, value] of blocks) for (const offset of offsets) byOffset.set(offset / 100, value);
  const keyframes = [...byOffset.entries()].sort((a, b) => a[0] - b[0]);
  return { durationMs, timing, keyframes };
}

/** The animated value at `progress` (0–1) through one iteration. */
export function keyframeOpacity(animation: CssAnimation, progress: number, vars: OpacityVars): number {
  const frames = animation.keyframes;
  if (frames.length === 0) return restingOpacity(vars);
  if (progress <= frames[0]![0]) return frames[0]![1](vars);
  for (let i = 0; i < frames.length - 1; i += 1) {
    const [fromOffset, fromValue] = frames[i]!;
    const [toOffset, toValue] = frames[i + 1]!;
    if (progress >= fromOffset && progress <= toOffset) {
      const span = toOffset - fromOffset;
      const u = span > 0 ? (progress - fromOffset) / span : 1;
      return lerp(fromValue(vars), toValue(vars), animation.timing(u));
    }
  }
  return frames[frames.length - 1]![1](vars);
}

/**
 * One dot running `animation` with `animation-delay: delayCycles × --dmx-cycle`,
 * both scaled by `--dmx-speed` (= 1 / speed). Before the delay has elapsed the
 * dot shows `.dmx-dot`'s resting opacity (`animation-fill-mode: none`).
 */
export function cssDotOpacity(
  animation: CssAnimation,
  delayCycles: number,
  elapsedMs: number,
  speed: number,
  vars: OpacityVars,
): number {
  const speedScale = 1 / (speed > 0 ? speed : 1);
  const duration = animation.durationMs * speedScale;
  const delay = delayCycles * DMX_CYCLE_MS * speedScale;
  if (elapsedMs < delay) return restingOpacity(vars);
  const local = (elapsedMs - delay) % duration;
  return keyframeOpacity(animation, local / duration, vars);
}

// ─── The stylesheet's animations ─────────────────────────────────────────────

const RIPPLE_3_BLOCKS: readonly KeyframeBlock[] = [
  [[0, 100], (v) => v.base],
  [[3], (v) => 0.62 * v.mid + 0.38 * v.base],
  [[6], (v) => 0.35 * v.peak + 0.65 * v.mid],
  [[10], (v) => v.peak],
  [[14], (v) => 0.35 * v.peak + 0.65 * v.mid],
  [[17], (v) => 0.62 * v.mid + 0.38 * v.base],
  [[20], (v) => v.base],
];

const RIPPLE_ECHO_BLOCKS: readonly KeyframeBlock[] = [
  [[0, 100], (v) => 0.625 * v.base],
  [[28], (v) => 0.98 * v.peak],
  [[56], (v) => v.mid],
  [[78], (v) => 0.68 * v.peak + 0.32 * v.mid],
];

const CENTER_ORIGIN_RIPPLE_BLOCKS: readonly KeyframeBlock[] = [
  [[0, 100], (v) => 0.625 * v.base],
  [[34], (v) => v.peak],
  [[60], (v) => 0.5 * (v.base + v.mid)],
];

const SNAKE_BLOCKS: readonly KeyframeBlock[] = [
  [[0, 100], (v) => 0.5 * v.base],
  [[8], (v) => v.peak],
  [[16], (v) => 0.5 * v.peak + 0.4 * v.mid + 0.1 * v.base],
  [[24], (v) => 0.25 * v.peak + 0.45 * v.mid + 0.3 * v.base],
  [[32], (v) => 0.5 * v.mid + 0.5 * v.base],
  [[40], (v) => 0.75 * v.base],
];

const RING_SNAKE_BLOCKS: readonly KeyframeBlock[] = [
  [[0, 100], (v) => 0.5 * v.base],
  [[10], (v) => v.peak],
  [[20], (v) => 0.45 * v.peak + 0.45 * v.mid + 0.1 * v.base],
  [[30], (v) => 0.2 * v.peak + 0.4 * v.mid + 0.4 * v.base],
  [[40], (v) => 0.875 * v.base],
];

const DIAGONAL_ALT_SWEEP_BLOCKS: readonly KeyframeBlock[] = [
  [[0, 100], (v) => 0.5 * v.base],
  [[14], (v) => v.peak],
  [[30], (v) => 0.75 * v.base],
];

const COL_SNAKE_BLOCKS: readonly KeyframeBlock[] = [
  [[0, 20], (v) => 0.6 * v.peak + 0.25 * v.mid + 0.15 * v.base],
  [[20, 40], (v) => 0.3 * v.peak + 0.5 * v.mid + 0.2 * v.base],
  [[40, 60], (v) => 0.6 * v.mid + 0.4 * v.base],
  [[60, 80], (v) => 0.2 * v.mid + 0.8 * v.base],
  [[80, 100], (v) => 0.625 * v.base],
];

const CIRCULAR2_RAMP: readonly KeyframeValue[] = [
  (v) => v.peak,
  (v) => 0.6 * v.peak + 0.4 * v.mid,
  (v) => 0.5 * v.mid + 0.5 * v.base,
  (v) => 0.3 * v.mid + 0.7 * v.base,
];

const CIRCULAR2_BLOCKS: readonly KeyframeBlock[] = Array.from({ length: 12 }, (_, i) => [
  [(i * 100) / 12, ((i + 1) * 100) / 12],
  CIRCULAR2_RAMP[i % 4]!,
]);

/** `dmx-square9-dN`: `[start, end, lit]` blocks in 52nds of the loop. */
function bitBlocks(spans: ReadonlyArray<readonly [number, number, 0 | 1]>): readonly KeyframeBlock[] {
  return spans.map(([start, end, lit]) => [
    [(start * 100) / 52, (end * 100) / 52],
    lit ? (v: OpacityVars) => v.peak : (v: OpacityVars) => v.base,
  ]);
}

export const CSS = {
  path3: cssAnimation(0.68 * DMX_CYCLE_MS, EASE_IN_OUT, RIPPLE_3_BLOCKS),
  centerRipple3: cssAnimation(0.82 * DMX_CYCLE_MS, EASE_IN_OUT, CENTER_ORIGIN_RIPPLE_BLOCKS),
  snakePath3: cssAnimation(1.04 * DMX_CYCLE_MS, EASE_IN_OUT, RIPPLE_3_BLOCKS),
  frameChase3: cssAnimation(0.98 * DMX_CYCLE_MS, EASE_IN_OUT, RIPPLE_3_BLOCKS),
  corePulse3: cssAnimation(0.46 * DMX_CYCLE_MS, EASE_IN_OUT, RIPPLE_3_BLOCKS),
  distanceRipple3: cssAnimation(1.3 * DMX_CYCLE_MS, EASE_OUT, RIPPLE_3_BLOCKS),
  rippleEcho3: cssAnimation(1.06 * DMX_CYCLE_MS, EASE_IN_OUT, RIPPLE_ECHO_BLOCKS),
  rippleEcho: cssAnimation(DMX_CYCLE_MS, EASE_IN_OUT, RIPPLE_ECHO_BLOCKS),
  centerOriginRipple: cssAnimation(DMX_CYCLE_MS, EASE_IN_OUT, CENTER_ORIGIN_RIPPLE_BLOCKS),
  diagonalAltSweep: cssAnimation(DMX_CYCLE_MS, LINEAR, DIAGONAL_ALT_SWEEP_BLOCKS),
  spiralSnake: cssAnimation(DMX_CYCLE_MS, LINEAR, SNAKE_BLOCKS),
  diagonalSnake: cssAnimation(DMX_CYCLE_MS, LINEAR, SNAKE_BLOCKS),
  outerSnake: cssAnimation(DMX_CYCLE_MS, LINEAR, RING_SNAKE_BLOCKS),
  middleSnake: cssAnimation(DMX_CYCLE_MS, LINEAR, RING_SNAKE_BLOCKS),
  square6ColSnake: cssAnimation(DMX_CYCLE_MS, stepsEnd(5), COL_SNAKE_BLOCKS),
  circular2Ring: cssAnimation(DMX_CYCLE_MS, stepsEnd(12), CIRCULAR2_BLOCKS),
  square9: [
    // d1
    bitBlocks([[0, 2, 0], [2, 16, 1], [16, 24, 0], [24, 26, 1], [26, 28, 0], [28, 30, 1], [30, 34, 0], [34, 37, 1], [37, 42, 0], [42, 44, 1], [44, 46, 0], [46, 48, 1], [48, 52, 0]]),
    // d2
    bitBlocks([[0, 3, 0], [3, 13, 1], [13, 16, 0], [16, 19, 1], [19, 26, 0], [26, 28, 1], [28, 30, 0], [30, 32, 1], [32, 34, 0], [34, 40, 1], [40, 42, 0], [42, 44, 1], [44, 46, 0], [46, 48, 1], [48, 52, 0]]),
    // d3
    bitBlocks([[0, 4, 0], [4, 13, 1], [13, 19, 0], [19, 22, 1], [22, 24, 0], [24, 26, 1], [26, 28, 0], [28, 30, 1], [30, 37, 0], [37, 40, 1], [40, 42, 0], [42, 44, 1], [44, 46, 0], [46, 48, 1], [48, 52, 0]]),
    // d4
    bitBlocks([[0, 7, 0], [7, 16, 1], [16, 26, 0], [26, 28, 1], [28, 30, 0], [30, 32, 1], [32, 34, 0], [34, 37, 1], [37, 44, 0], [44, 46, 1], [46, 48, 0], [48, 50, 1], [50, 52, 0]]),
    // d5
    bitBlocks([[0, 8, 0], [8, 13, 1], [13, 16, 0], [16, 19, 1], [19, 24, 0], [24, 26, 1], [26, 28, 0], [28, 30, 1], [30, 34, 0], [34, 40, 1], [40, 44, 0], [44, 46, 1], [46, 48, 0], [48, 50, 1], [50, 52, 0]]),
    // d6
    bitBlocks([[0, 9, 0], [9, 13, 1], [13, 19, 0], [19, 22, 1], [22, 26, 0], [26, 28, 1], [28, 30, 0], [30, 32, 1], [32, 37, 0], [37, 40, 1], [40, 44, 0], [44, 46, 1], [46, 48, 0], [48, 50, 1], [50, 52, 0]]),
  ].map((blocks) => cssAnimation(5200, stepsEnd(52), blocks)),
} as const;
