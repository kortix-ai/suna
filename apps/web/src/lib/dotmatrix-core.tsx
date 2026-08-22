"use client";

import type { CSSProperties } from "react";

import "@/components/dotmatrix-loader.css";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { useDotMatrixPhases, usePrefersReducedMotion, useCyclePhase } from "@/lib/dotmatrix-hooks";

export type MatrixPattern = "diamond" | "full" | "outline" | "rose" | "cross" | "rings";
export type DotShape = "circle" | "square" | "diamond" | "hearts";
export type DotMatrixPhase = "idle" | "collapse" | "hoverRipple" | "loadingRipple";
export type DotMatrixColorPreset =
  | "solid-theme"
  | "solid-mint"
  | "grad-sunset"
  | "grad-ocean"
  | "grad-neon"
  | "grad-aurora"
  | "grad-fire"
  | "grad-prism";

const DOT_MATRIX_COLOR_PRESETS: Record<
  DotMatrixColorPreset,
  {
    fill: string;
    glow: string;
  }
> = {
  "solid-theme": {
    fill: "var(--color-dot-on)",
    glow: "var(--color-dot-on)"
  },
  "solid-mint": {
    fill: "#34d399",
    glow: "#34d399"
  },
  "grad-sunset": {
    fill: "linear-gradient(135deg, #ff5f6d 0%, #ffc371 52%, #ffe29a 100%)",
    glow: "#ff8b73"
  },
  "grad-ocean": {
    fill: "linear-gradient(140deg, #00c6ff 0%, #0072ff 48%, #4facfe 100%)",
    glow: "#2f8fff"
  },
  "grad-neon": {
    fill: "linear-gradient(145deg, #b4ff39 0%, #39ffb6 46%, #00d4ff 100%)",
    glow: "#59ffc8"
  },
  "grad-aurora": {
    fill: "linear-gradient(145deg, #ff3cac 0%, #784ba0 45%, #2b86c5 100%)",
    glow: "#9c64bf"
  },
  "grad-fire": {
    fill: "linear-gradient(145deg, #ff512f 0%, #dd2476 45%, #ffb347 100%)",
    glow: "#f96a5f"
  },
  "grad-prism": {
    fill: "linear-gradient(145deg, #12c2e9 0%, #c471ed 45%, #f64f59 100%)",
    glow: "#9e7de8"
  }
};

export function resolveDmxColorTokens(color: string, colorPreset?: DotMatrixColorPreset): {
  resolvedColor: string;
  dotFill: string;
} {
  if (!colorPreset) {
    return { resolvedColor: color, dotFill: color };
  }

  const preset = DOT_MATRIX_COLOR_PRESETS[colorPreset];
  if (!preset) {
    return { resolvedColor: color, dotFill: color };
  }

  return { resolvedColor: preset.glow, dotFill: preset.fill };
}

export interface DotMatrixCommonProps {
  size?: number;
  dotSize?: number;
  /** Multiplies `size` and `dotSize` together. `1` is the component's own base. */
  scale?: number;
  color?: string;
  colorPreset?: DotMatrixColorPreset;
  speed?: number;
  ariaLabel?: string;
  className?: string;
  pattern?: MatrixPattern;
  muted?: boolean;
  /**
   * Adds a glow on dots from opacity 0.6 (weakest) through 1 (strongest), after remapping.
   */
  bloom?: boolean;
  /** Uniform glow on every active dot (0…1); slightly wider falloff than selective `bloom`. */
  halo?: number;
  animated?: boolean;
  hoverAnimated?: boolean;
  dotClassName?: string;
  dotShape?: DotShape;
  opacityBase?: number;
  opacityMid?: number;
  opacityPeak?: number;
  cellPadding?: number;
  boxSize?: number;
  minSize?: number;
}

/** Multiplies `size` and `dotSize`. Values `<= 0` fall back to `1`. */
export function applyDotMatrixScale(
  size: number,
  dotSize: number,
  scale?: number
): { size: number; dotSize: number } {
  const factor = scale != null && scale > 0 ? scale : 1;
  return { size: size * factor, dotSize: dotSize * factor };
}

export interface DotAnimationContext {
  index: number;
  row: number;
  col: number;
  distanceFromCenter: number;
  angleFromCenter: number;
  radiusNormalized: number;
  manhattanDistance: number;
  phase: DotMatrixPhase;
  isActive: boolean;
  reducedMotion: boolean;
}

export interface DotAnimationState {
  className?: string;
  style?: CSSProperties;
}

export type DotAnimationResolver = (ctx: DotAnimationContext) => DotAnimationState;

export function cx(...values: Array<string | undefined | null | false>): string {
  return values.filter(Boolean).join(" ");
}

export const MATRIX_SIZE = 5;
const CENTER = Math.floor(MATRIX_SIZE / 2);
const RANGE = Array.from({ length: MATRIX_SIZE }, (_, index) => index);
const MAX_RADIUS = Math.hypot(CENTER, CENTER);

export const FULL_INDEXES = RANGE.flatMap((row) => RANGE.map((col) => rowMajorIndex(row, col)));

export const DIAMOND_INDEXES = FULL_INDEXES.filter((index) => {
  const { row, col } = indexToCoord(index);
  return Math.abs(row - CENTER) + Math.abs(col - CENTER) <= 2;
});

export const OUTLINE_INDEXES = FULL_INDEXES.filter((index) => {
  const { row, col } = indexToCoord(index);
  return row === 0 || row === MATRIX_SIZE - 1 || col === 0 || col === MATRIX_SIZE - 1;
});

export const CROSS_INDEXES = FULL_INDEXES.filter((index) => {
  const { row, col } = indexToCoord(index);
  return row === CENTER || col === CENTER;
});

export const RINGS_INDEXES = FULL_INDEXES.filter((index) => {
  const { row, col } = indexToCoord(index);
  const radius = Math.hypot(row - CENTER, col - CENTER);
  return Math.round(radius) === 1 || Math.round(radius) === 2;
});

export const ROSE_INDEXES = FULL_INDEXES.filter((index) => {
  const { row, col } = indexToCoord(index);
  const dx = col - CENTER;
  const dy = row - CENTER;
  const angle = Math.atan2(dy, dx);
  const radius = Math.hypot(dx, dy);
  const rose = Math.abs(Math.sin(3 * angle));
  return rose > 0.6 && radius >= 1;
});

const PATTERN_INDEXES: Record<MatrixPattern, number[]> = {
  diamond: DIAMOND_INDEXES,
  full: FULL_INDEXES,
  outline: OUTLINE_INDEXES,
  rose: ROSE_INDEXES,
  cross: CROSS_INDEXES,
  rings: RINGS_INDEXES
};

export function getPatternIndexes(pattern: MatrixPattern = "diamond"): number[] {
  return PATTERN_INDEXES[pattern];
}

export function rowMajorIndex(row: number, col: number): number {
  return row * MATRIX_SIZE + col;
}

export function indexToCoord(index: number): { row: number; col: number } {
  return {
    row: Math.floor(index / MATRIX_SIZE),
    col: index % MATRIX_SIZE
  };
}

export function distanceFromCenter(index: number): number {
  const { row, col } = indexToCoord(index);
  return Math.hypot(row - CENTER, col - CENTER);
}

export function rowDistance(index: number): number {
  const { row } = indexToCoord(index);
  return Math.abs(row - CENTER);
}

export function polarAngle(index: number): number {
  const { row, col } = indexToCoord(index);
  return Math.atan2(row - CENTER, col - CENTER);
}

export function normalizedRadius(index: number): number {
  const { row, col } = indexToCoord(index);
  return Math.hypot(row - CENTER, col - CENTER) / MAX_RADIUS;
}

export function manhattanDistance(index: number): number {
  const { row, col } = indexToCoord(index);
  return Math.abs(row - CENTER) + Math.abs(col - CENTER);
}

export function harmonicPhase(row: number, col: number, a: number, b: number): number {
  return Math.sin((row + 1) * a + (col + 1) * b);
}

export function lissajousOffset(
  row: number,
  col: number,
  amplitude = 2.25
): { x: number; y: number; phase: number } {
  const x = Math.sin((row + 1) * 1.15 + (col + 1) * 2.2) * amplitude;
  const y = Math.cos((row + 1) * 2.45 + (col + 1) * 0.95) * amplitude;
  const phase = Math.abs(Math.sin((row + 1) * 0.7 + (col + 1) * 1.1));
  return { x, y, phase };
}

export function spiralOffset(
  angle: number,
  radiusNormalizedValue: number,
  amplitude = 2.8
): { x: number; y: number; phase: number } {
  const spin = angle + radiusNormalizedValue * Math.PI * 2.1;
  const radius = radiusNormalizedValue * amplitude;
  const x = Math.cos(spin) * radius;
  const y = Math.sin(spin) * radius;
  const phase = Math.abs(Math.sin(spin * 0.5));
  return { x, y, phase };
}

export function isPrime(value: number): boolean {
  if (value <= 1) {
    return false;
  }
  if (value === 2) {
    return true;
  }
  if (value % 2 === 0) {
    return false;
  }

  const limit = Math.floor(Math.sqrt(value));
  for (let divisor = 3; divisor <= limit; divisor += 2) {
    if (value % divisor === 0) {
      return false;
    }
  }

  return true;
}

const N = MATRIX_SIZE;
const C = Math.floor(MATRIX_SIZE / 2);
const CELLS = N * N;
const MAX_TRBL = (N - 1) * 2;

export function trBlPathNormFromIndex(index: number): number {
  const { row, col } = indexToCoord(index);
  return (row + (N - 1 - col)) / MAX_TRBL;
}

function buildSnakeOrderToIndexMap(): number[] {
  const pathOrder = new Array<number>(CELLS);
  const key = (row: number, col: number) => rowMajorIndex(row, col);
  let t = 0;
  for (let row = 0; row < N; row += 1) {
    if (row % 2 === 0) {
      for (let col = 0; col < N; col += 1) {
        pathOrder[key(row, col)] = t;
        t += 1;
      }
    } else {
      for (let col = N - 1; col >= 0; col -= 1) {
        pathOrder[key(row, col)] = t;
        t += 1;
      }
    }
  }
  return pathOrder;
}

const SNAKE_ORDER: readonly number[] = buildSnakeOrderToIndexMap();

export function snakePathNormFromIndex(index: number): number {
  return SNAKE_ORDER[index]! / (CELLS - 1);
}

export function snakePathOrderValue(index: number): number {
  return SNAKE_ORDER[index]!;
}

function buildSpiralInwardOrderToIndexMap(): number[] {
  const order = new Array<number>(CELLS);
  let top = 0;
  let bottom = N - 1;
  let left = 0;
  let right = N - 1;
  let t = 0;

  while (top <= bottom && left <= right) {
    for (let col = left; col <= right; col += 1) {
      order[rowMajorIndex(top, col)] = t;
      t += 1;
    }

    for (let row = top + 1; row <= bottom; row += 1) {
      order[rowMajorIndex(row, right)] = t;
      t += 1;
    }

    if (top < bottom) {
      for (let col = right - 1; col >= left; col -= 1) {
        order[rowMajorIndex(bottom, col)] = t;
        t += 1;
      }
    }

    if (left < right) {
      for (let row = bottom - 1; row > top; row -= 1) {
        order[rowMajorIndex(row, left)] = t;
        t += 1;
      }
    }

    top += 1;
    bottom -= 1;
    left += 1;
    right -= 1;
  }

  return order;
}

const SPIRAL_INWARD_ORDER: readonly number[] = buildSpiralInwardOrderToIndexMap();

export function spiralInwardNormFromIndex(index: number): number {
  return SPIRAL_INWARD_ORDER[index]! / (CELLS - 1);
}

export function spiralInwardOrderValue(index: number): number {
  return SPIRAL_INWARD_ORDER[index]!;
}

function buildOuterRingClockwiseOrderToIndexMap(): number[] {
  const order = new Array<number>(CELLS).fill(-1);
  const coords: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 4],
    [4, 3],
    [4, 2],
    [4, 1],
    [4, 0],
    [3, 0],
    [2, 0],
    [1, 0]
  ];

  for (let t = 0; t < coords.length; t += 1) {
    const [row, col] = coords[t]!;
    order[rowMajorIndex(row, col)] = t;
  }

  return order;
}

function buildMiddleRingAntiClockwiseOrderToIndexMap(): number[] {
  const order = new Array<number>(CELLS).fill(-1);
  const coords: Array<[number, number]> = [
    [1, 1],
    [2, 1],
    [3, 1],
    [3, 2],
    [3, 3],
    [2, 3],
    [1, 3],
    [1, 2]
  ];

  for (let t = 0; t < coords.length; t += 1) {
    const [row, col] = coords[t]!;
    order[rowMajorIndex(row, col)] = t;
  }

  return order;
}

const OUTER_RING_CLOCKWISE_ORDER: readonly number[] = buildOuterRingClockwiseOrderToIndexMap();
const MIDDLE_RING_ANTI_CLOCKWISE_ORDER: readonly number[] = buildMiddleRingAntiClockwiseOrderToIndexMap();

export function outerRingClockwiseOrderValue(index: number): number {
  return OUTER_RING_CLOCKWISE_ORDER[index]!;
}

export function outerRingClockwiseNormFromIndex(index: number): number {
  const order = outerRingClockwiseOrderValue(index);
  return order >= 0 ? order / 15 : 0;
}

export function middleRingAntiClockwiseOrderValue(index: number): number {
  return MIDDLE_RING_ANTI_CLOCKWISE_ORDER[index]!;
}

export function middleRingAntiClockwiseNormFromIndex(index: number): number {
  const order = middleRingAntiClockwiseOrderValue(index);
  return order >= 0 ? order / 7 : 0;
}

function buildDiagonalSnakeOrderToIndexMap(): number[] {
  const order = new Array<number>(CELLS);
  let t = 0;

  for (let diagonal = 0; diagonal <= (N - 1) * 2; diagonal += 1) {
    const rowStart = Math.max(0, diagonal - (N - 1));
    const rowEnd = Math.min(N - 1, diagonal);

    if (diagonal % 2 === 0) {
      for (let row = rowEnd; row >= rowStart; row -= 1) {
        const col = diagonal - row;
        order[rowMajorIndex(row, col)] = t;
        t += 1;
      }
    } else {
      for (let row = rowStart; row <= rowEnd; row += 1) {
        const col = diagonal - row;
        order[rowMajorIndex(row, col)] = t;
        t += 1;
      }
    }
  }

  return order;
}

const DIAGONAL_SNAKE_ORDER: readonly number[] = buildDiagonalSnakeOrderToIndexMap();

export function diagonalSnakeOrderValue(index: number): number {
  return DIAGONAL_SNAKE_ORDER[index]!;
}

export function diagonalSnakeNormFromIndex(index: number): number {
  return DIAGONAL_SNAKE_ORDER[index]! / (CELLS - 1);
}

function buildRowWaveSnakeOrderToIndexMap(): number[] {
  const order = new Array<number>(CELLS);
  const route: Array<{ col: number; dir: "up" | "down" }> = [
    { col: 0, dir: "up" },
    { col: 2, dir: "down" },
    { col: 1, dir: "up" },
    { col: 3, dir: "down" },
    { col: 2, dir: "up" },
    { col: 4, dir: "down" }
  ];

  let t = 0;
  for (const step of route) {
    if (step.dir === "up") {
      for (let row = N - 1; row >= 0; row -= 1) {
        order[rowMajorIndex(row, step.col)] = t;
        t += 1;
      }
    } else {
      for (let row = 0; row < N; row += 1) {
        order[rowMajorIndex(row, step.col)] = t;
        t += 1;
      }
    }
  }

  return order;
}

const ROW_WAVE_SNAKE_ORDER: readonly number[] = buildRowWaveSnakeOrderToIndexMap();
const ROW_WAVE_SNAKE_MAX_ORDER = Math.max(...ROW_WAVE_SNAKE_ORDER);

export function rowWaveOrderValue(index: number): number {
  return ROW_WAVE_SNAKE_ORDER[index]!;
}

export function rowWaveNormFromIndex(index: number): number {
  return ROW_WAVE_SNAKE_MAX_ORDER > 0 ? rowWaveOrderValue(index) / ROW_WAVE_SNAKE_MAX_ORDER : 0;
}

export function colWaveNormFromIndex(index: number): number {
  const { col } = indexToCoord(index);
  return N > 1 ? col / (N - 1) : 0;
}

export function concentricRingNormFromIndex(index: number): number {
  const { row, col } = indexToCoord(index);
  return Math.max(Math.abs(row - C), Math.abs(col - C)) / C;
}

const CORNER_COORDS = new Set(["0,0", "0,4", "4,0", "4,4"]);

export function isWithinCircularMask(row: number, col: number): boolean {
  return !CORNER_COORDS.has(`${row},${col}`);
}

export function stylePx(n: number): string {
  return `${n}px`;
}

export function styleOpacity(opacity: number): number {
  return Math.round(opacity * 1e6) / 1e6;
}

const SOURCE_BASE_OPACITY = 0.08;
const SOURCE_MID_OPACITY = 0.34;
const SOURCE_PEAK_OPACITY = 0.94;

function lerpDmx(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function normalizeProgressDmx(value: number, start: number, end: number): number {
  const span = end - start;
  if (Math.abs(span) < Number.EPSILON) {
    return 0;
  }
  return Math.min(1, Math.max(0, (value - start) / span));
}

function coerceOpacityDmx(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

export function remapOpacityToTriplet(
  opacity: number,
  opacityBase: number | undefined,
  opacityMid: number | undefined,
  opacityPeak: number | undefined
): number {
  if (!Number.isFinite(opacity)) {
    return opacity;
  }

  const hasOverrides = opacityBase !== undefined || opacityMid !== undefined || opacityPeak !== undefined;
  const safeOpacity = Math.min(1, Math.max(0, opacity));
  if (!hasOverrides) {
    return safeOpacity;
  }

  const targetBase = coerceOpacityDmx(opacityBase) ?? SOURCE_BASE_OPACITY;
  const targetMid = coerceOpacityDmx(opacityMid) ?? SOURCE_MID_OPACITY;
  const targetPeak = coerceOpacityDmx(opacityPeak) ?? SOURCE_PEAK_OPACITY;

  if (safeOpacity <= SOURCE_BASE_OPACITY) {
    const progress = normalizeProgressDmx(safeOpacity, 0, SOURCE_BASE_OPACITY);
    return Math.min(1, Math.max(0, lerpDmx(0, targetBase, progress)));
  }

  if (safeOpacity <= SOURCE_MID_OPACITY) {
    const progress = normalizeProgressDmx(safeOpacity, SOURCE_BASE_OPACITY, SOURCE_MID_OPACITY);
    return Math.min(1, Math.max(0, lerpDmx(targetBase, targetMid, progress)));
  }

  if (safeOpacity <= SOURCE_PEAK_OPACITY) {
    const progress = normalizeProgressDmx(safeOpacity, SOURCE_MID_OPACITY, SOURCE_PEAK_OPACITY);
    return Math.min(1, Math.max(0, lerpDmx(targetMid, targetPeak, progress)));
  }

  const progress = normalizeProgressDmx(safeOpacity, SOURCE_PEAK_OPACITY, 1);
  return Math.min(1, Math.max(0, lerpDmx(targetPeak, 1, progress)));
}

/** Remapped opacity where bloom begins (weakest glow); scales linearly to full bloom at 1. */
export const DMX_BLOOM_OPACITY_MIN = 0.6;

export function opacityToBloomLevel(remappedOpacity: number): number {
  return Math.max(0, Math.min(1, (remappedOpacity - DMX_BLOOM_OPACITY_MIN) / (1 - DMX_BLOOM_OPACITY_MIN)));
}

export function remappedOpacityQualifiesForBloom(remappedOpacity: number): boolean {
  return remappedOpacity >= DMX_BLOOM_OPACITY_MIN;
}

function clampHalo(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function dmxBloomRootActive(bloom: boolean, halo: number | undefined): boolean {
  return bloom || clampHalo(halo) > 0;
}

/** Root class when `halo` > 0 — CSS widens drop-shadow falloff for a softer, more diffuse glow. */
export function dmxBloomHaloSpreadClass(halo: number | undefined): "dmx-bloom-halo" | false {
  return clampHalo(halo) > 0 ? "dmx-bloom-halo" : false;
}

/**
 * Bloom level and dot class for one cell. `curveOpacity` is the loader’s logical opacity **before**
 * `remapOpacityToTriplet` (same as `bloom` uses today).
 */
export function dmxDotBloomParts(
  isActive: boolean,
  curveOpacity: number,
  bloom: boolean,
  halo: number | undefined,
  ob: number | undefined,
  om: number | undefined,
  op: number | undefined
): { level: number; bloomDot: boolean } {
  const haloN = clampHalo(halo);
  if (!isActive) {
    return { level: 0, bloomDot: false };
  }
  const remapped = remapOpacityToTriplet(curveOpacity, ob, om, op);
  const fromBloom = bloom ? opacityToBloomLevel(remapped) : 0;
  return {
    level: fromBloom,
    bloomDot: haloN > 0 || (bloom && remappedOpacityQualifiesForBloom(remapped))
  };
}

function getMatrix5Layout(
  size: number,
  dotSize: number,
  cellPadding?: number
): { gap: number; matrixSpan: number } {
  const n = MATRIX_SIZE;
  if (cellPadding != null) {
    const g = Math.max(0, cellPadding);
    const matrixSpan = dotSize * n + g * (n - 1);
    return { gap: g, matrixSpan };
  }
  const g = Math.max(1, Math.floor((size - dotSize * n) / (n - 1)));
  return { gap: g, matrixSpan: size };
}

function resolveDmxBoxOuterDim(
  options: { boxSize?: number; minSize?: number } | null | undefined
): { outerDim: number; useWrapper: boolean } {
  const b = options?.boxSize;
  const hasBox = b != null && b > 0 && Number.isFinite(b);
  if (!hasBox) {
    return { outerDim: 0, useWrapper: false };
  }
  const m = options?.minSize;
  if (m != null && m > 0 && Number.isFinite(m)) {
    return { outerDim: Math.max(b, m), useWrapper: true };
  }
  return { outerDim: b, useWrapper: true };
}

function clamp01Dmx(n: number | undefined) {
  if (n == null) {
    return;
  }
  if (!Number.isFinite(n)) {
    return;
  }
  return Math.min(1, Math.max(0, n));
}

interface DotMatrixBaseProps extends DotMatrixCommonProps {
  phase: DotMatrixPhase;
  reducedMotion?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  animationResolver?: DotAnimationResolver;
}

export function DotMatrixBase({
  scale: scaleProp,
  size: sizeProp = 24,
  dotSize: dotSizeProp = 3,
  color = "currentColor",
  colorPreset,
  speed = 1,
  ariaLabel = "Loading",
  className,
  pattern = "diamond",
  dotShape = "circle",
  muted = false,
  bloom = false,
  halo = 0,
  dotClassName,
  phase,
  reducedMotion = false,
  onMouseEnter,
  onMouseLeave,
  animationResolver,
  opacityBase,
  opacityMid,
  opacityPeak,
  cellPadding,
  boxSize,
  minSize
}: DotMatrixBaseProps) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scaleProp);
  const patternIndexes = new Set(getPatternIndexes(pattern));
  const safeSpeed = speed > 0 ? speed : 1;
  const speedScale = 1 / safeSpeed;
  const { gap, matrixSpan } = getMatrix5Layout(size, dotSize, cellPadding);
  const { outerDim, useWrapper } = resolveDmxBoxOuterDim({ boxSize, minSize });
  const boxScale = useWrapper && matrixSpan > 0 ? outerDim / matrixSpan : 1;
  const center = Math.floor(MATRIX_SIZE / 2);
  const ob = clamp01Dmx(opacityBase);
  const om = clamp01Dmx(opacityMid);
  const op = clamp01Dmx(opacityPeak);
  const unit = dotSize + gap;
  const { resolvedColor, dotFill } = resolveDmxColorTokens(color, colorPreset);

  const dmxVarStyle = {
    width: matrixSpan,
    height: matrixSpan,
    "--dmx-speed": speedScale,
    ["--dmx-dot-size" as const]: `${dotSize}px`,
    ["--dmx-halo-level" as const]: halo,
    ["--dmx-dot-fill" as const]: dotFill,
    color: resolvedColor,
    ...(ob !== undefined && { ["--dmx-opacity-base" as const]: ob }),
    ...(om !== undefined && { ["--dmx-opacity-mid" as const]: om }),
    ...(op !== undefined && { ["--dmx-opacity-peak" as const]: op }),
    ...(useWrapper
      ? {
        transform: `scale(${boxScale})`,
        transformOrigin: "center center" as const
      }
      : { minWidth: minSize, minHeight: minSize })
  } as unknown as CSSProperties;

  const dots = Array.from({ length: MATRIX_SIZE * MATRIX_SIZE }).map((_, index) => {
    const { row, col } = indexToCoord(index);
    const isActive = patternIndexes.has(index);
    const distance = distanceFromCenter(index);
    const angle = polarAngle(index);
    const radiusNormalizedValue = normalizedRadius(index);
    const manhattan = manhattanDistance(index);
    const deltaX = (col - center) * unit;
    const deltaY = (row - center) * unit;

    const animationState = animationResolver
      ? animationResolver({
        index,
        row,
        col,
        distanceFromCenter: distance,
        angleFromCenter: angle,
        radiusNormalized: radiusNormalizedValue,
        manhattanDistance: manhattan,
        phase,
        isActive,
        reducedMotion
      })
      : {};

    const resolvedAnimationStyle = animationState.style ? { ...animationState.style } : undefined;
    let isBloomDot = false;
    let stylePatch: CSSProperties | undefined = resolvedAnimationStyle;

    if (isActive) {
      const rawOpacity = stylePatch?.opacity;
      if (stylePatch != null && typeof rawOpacity === "number") {
        const remappedOpacity = remapOpacityToTriplet(rawOpacity, ob, om, op);
        stylePatch = { ...stylePatch, opacity: remappedOpacity };
        const parts = dmxDotBloomParts(true, rawOpacity, bloom, halo, ob, om, op);
        (stylePatch as CSSProperties & { "--dmx-bloom-level"?: number })["--dmx-bloom-level"] = parts.level;
        isBloomDot = parts.bloomDot;
      } else {
        const parts = dmxDotBloomParts(true, 0, bloom, halo, ob, om, op);
        if (parts.level > 0) {
          stylePatch = {
            ...(stylePatch ?? {}),
            ["--dmx-bloom-level" as const]: parts.level
          } as CSSProperties & { "--dmx-bloom-level"?: number };
        }
        isBloomDot = parts.bloomDot;
      }
    }

    const dotStyle = {
      width: dotSize,
      height: dotSize,
      "--dmx-distance": distance,
      "--dmx-row": row,
      "--dmx-col": col,
      "--dmx-x": `${deltaX}px`,
      "--dmx-y": `${deltaY}px`,
      "--dmx-angle": angle,
      "--dmx-radius": radiusNormalizedValue,
      "--dmx-manhattan": manhattan,
      ...stylePatch,
      ...(!isActive
        ? {
          opacity: 0,
          visibility: "hidden" as const,
          pointerEvents: "none" as const,
          animation: "none"
        }
        : {})
    } as CSSProperties;

    return (
      <span
        key={index}
        aria-hidden="true"
        className={cx(
          "dmx-dot",
          !isActive && "dmx-inactive",
          isBloomDot && "dmx-bloom-dot",
          dotClassName,
          animationState.className
        )}
        style={dotStyle}
      />
    );
  });

  const matrix = (
    <div
      className={cx(
        "dmx-root",
        `dmx-dot-shape-${dotShape}`,
        muted && "dmx-muted",
        dmxBloomRootActive(bloom, halo) && "dmx-bloom",
        dmxBloomHaloSpreadClass(halo),
        !useWrapper && className
      )}
      style={dmxVarStyle}
    >
      <div className="dmx-grid" style={{ gap }}>{dots}</div>
    </div>
  );

  if (useWrapper) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={ariaLabel}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: outerDim,
          height: outerDim,
          minWidth: minSize,
          minHeight: minSize,
          overflow: "hidden"
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {matrix}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={cx(
        "dmx-root",
        `dmx-dot-shape-${dotShape}`,
        muted && "dmx-muted",
        dmxBloomRootActive(bloom, halo) && "dmx-bloom",
        dmxBloomHaloSpreadClass(halo),
        className
      )}
      style={dmxVarStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="dmx-grid" style={{ gap }}>{dots}</div>
    </div>
  );
}

export const MATRIX_SIZE_3 = 3;

const CENTER_3 = Math.floor(MATRIX_SIZE_3 / 2);
const RANGE_3 = Array.from({ length: MATRIX_SIZE_3 }, (_, index) => index);
const MAX_RADIUS_3 = Math.hypot(CENTER_3, CENTER_3);

export const FULL_INDEXES_3 = RANGE_3.flatMap((row) =>
  RANGE_3.map((col) => rowMajorIndex3(row, col))
);

export const OUTLINE_INDEXES_3 = FULL_INDEXES_3.filter((index) => {
  const { row, col } = indexToCoord3(index);
  return row === 0 || row === MATRIX_SIZE_3 - 1 || col === 0 || col === MATRIX_SIZE_3 - 1;
});

export const DIAMOND_INDEXES_3 = FULL_INDEXES_3.filter((index) => {
  const { row, col } = indexToCoord3(index);
  return Math.abs(row - CENTER_3) + Math.abs(col - CENTER_3) <= 1;
});

export const CROSS_INDEXES_3 = FULL_INDEXES_3.filter((index) => {
  const { row, col } = indexToCoord3(index);
  return row === CENTER_3 || col === CENTER_3;
});

export const RINGS_INDEXES_3 = FULL_INDEXES_3.filter((index) => {
  const { row, col } = indexToCoord3(index);
  return Math.round(Math.hypot(row - CENTER_3, col - CENTER_3)) === 1;
});

export const ROSE_INDEXES_3 = FULL_INDEXES_3.filter((index) => {
  const { row, col } = indexToCoord3(index);
  const dx = col - CENTER_3;
  const dy = row - CENTER_3;
  const angle = Math.atan2(dy, dx);
  const radius = Math.hypot(dx, dy);
  const rose = Math.abs(Math.sin(3 * angle));
  return rose > 0.55 && radius >= 0.75;
});

const PATTERN_INDEXES_3: Record<MatrixPattern, number[]> = {
  diamond: DIAMOND_INDEXES_3,
  full: FULL_INDEXES_3,
  outline: OUTLINE_INDEXES_3,
  rose: ROSE_INDEXES_3,
  cross: CROSS_INDEXES_3,
  rings: RINGS_INDEXES_3
};

export function getPattern3Indexes(pattern: MatrixPattern = "full"): number[] {
  return PATTERN_INDEXES_3[pattern];
}

export function rowMajorIndex3(row: number, col: number): number {
  return row * MATRIX_SIZE_3 + col;
}

export function indexToCoord3(index: number): { row: number; col: number } {
  return {
    row: Math.floor(index / MATRIX_SIZE_3),
    col: index % MATRIX_SIZE_3
  };
}

export function distanceFromCenter3(index: number): number {
  const { row, col } = indexToCoord3(index);
  return Math.hypot(row - CENTER_3, col - CENTER_3);
}

export function manhattanDistance3(index: number): number {
  const { row, col } = indexToCoord3(index);
  return Math.abs(row - CENTER_3) + Math.abs(col - CENTER_3);
}

const MAX_DIAGONAL_3 = (MATRIX_SIZE_3 - 1) * 2;

export type DiagonalWave3Direction = "tr-bl" | "tl-br" | "br-tl" | "bl-tr";

export function trBlPath3NormFromIndex(index: number): number {
  const { row, col } = indexToCoord3(index);
  return (row + (MATRIX_SIZE_3 - 1 - col)) / MAX_DIAGONAL_3;
}

export function tlBrPath3NormFromIndex(index: number): number {
  const { row, col } = indexToCoord3(index);
  return (row + col) / MAX_DIAGONAL_3;
}

export function brTlPath3NormFromIndex(index: number): number {
  const { row, col } = indexToCoord3(index);
  return (MAX_DIAGONAL_3 - row - col) / MAX_DIAGONAL_3;
}

export function blTrPath3NormFromIndex(index: number): number {
  const { row, col } = indexToCoord3(index);
  return (MAX_DIAGONAL_3 - row - (MATRIX_SIZE_3 - 1 - col)) / MAX_DIAGONAL_3;
}

const DIAGONAL_PATH_3: Record<DiagonalWave3Direction, (index: number) => number> = {
  "tr-bl": trBlPath3NormFromIndex,
  "tl-br": tlBrPath3NormFromIndex,
  "br-tl": brTlPath3NormFromIndex,
  "bl-tr": blTrPath3NormFromIndex
};

export function diagonalWave3PathNormFromIndex(
  index: number,
  direction: DiagonalWave3Direction
): number {
  return DIAGONAL_PATH_3[direction](index);
}

export function diagonalWave3BandIndex(
  row: number,
  col: number,
  direction: DiagonalWave3Direction
): number {
  if (direction === "tr-bl" || direction === "bl-tr") {
    return row + (MATRIX_SIZE_3 - 1 - col);
  }
  return row + col;
}

function buildSpiralInwardOrderToIndexMap3(): number[] {
  const N = MATRIX_SIZE_3;
  const CELLS = N * N;
  const order = new Array<number>(CELLS);
  let top = 0;
  let bottom = N - 1;
  let left = 0;
  let right = N - 1;
  let t = 0;

  while (top <= bottom && left <= right) {
    for (let col = left; col <= right; col += 1) {
      order[rowMajorIndex3(top, col)] = t;
      t += 1;
    }

    for (let row = top + 1; row <= bottom; row += 1) {
      order[rowMajorIndex3(row, right)] = t;
      t += 1;
    }

    if (top < bottom) {
      for (let col = right - 1; col >= left; col -= 1) {
        order[rowMajorIndex3(bottom, col)] = t;
        t += 1;
      }
    }

    if (left < right) {
      for (let row = bottom - 1; row > top; row -= 1) {
        order[rowMajorIndex3(row, left)] = t;
        t += 1;
      }
    }

    top += 1;
    bottom -= 1;
    left += 1;
    right -= 1;
  }

  return order;
}

function buildSnakeOrderToIndexMap3(): number[] {
  const N = MATRIX_SIZE_3;
  const order = new Array<number>(N * N);
  let t = 0;
  for (let row = 0; row < N; row += 1) {
    if (row % 2 === 0) {
      for (let col = 0; col < N; col += 1) {
        order[rowMajorIndex3(row, col)] = t;
        t += 1;
      }
    } else {
      for (let col = N - 1; col >= 0; col -= 1) {
        order[rowMajorIndex3(row, col)] = t;
        t += 1;
      }
    }
  }
  return order;
}

const SNAKE_ORDER_3: readonly number[] = buildSnakeOrderToIndexMap3();

export function snakePath3NormFromIndex(index: number): number {
  return SNAKE_ORDER_3[index]! / (MATRIX_SIZE_3 * MATRIX_SIZE_3 - 1);
}

export function snakePath3OrderValue(index: number): number {
  return SNAKE_ORDER_3[index]!;
}

const SPIRAL_INWARD_ORDER_3: readonly number[] = buildSpiralInwardOrderToIndexMap3();

export function spiralInward3NormFromIndex(index: number): number {
  return SPIRAL_INWARD_ORDER_3[index]! / (MATRIX_SIZE_3 * MATRIX_SIZE_3 - 1);
}

export function spiralInward3OrderValue(index: number): number {
  return SPIRAL_INWARD_ORDER_3[index]!;
}

function buildOuterRingClockwiseOrder3(): number[] {
  const order = new Array<number>(MATRIX_SIZE_3 * MATRIX_SIZE_3).fill(-1);
  const path: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
    [2, 2],
    [2, 1],
    [2, 0],
    [1, 0]
  ];

  path.forEach(([row, col], step) => {
    order[rowMajorIndex3(row, col)] = step;
  });

  return order;
}

const OUTER_RING_CLOCKWISE_ORDER_3: readonly number[] = buildOuterRingClockwiseOrder3();

export function outerRingClockwise3OrderValue(index: number): number {
  return OUTER_RING_CLOCKWISE_ORDER_3[index]!;
}

export function outerRingClockwise3NormFromIndex(index: number): number {
  const order = OUTER_RING_CLOCKWISE_ORDER_3[index]!;
  if (order < 0) {
    return 0;
  }
  return order / 7;
}

export function isCenterCell3(row: number, col: number): boolean {
  const center = Math.floor(MATRIX_SIZE_3 / 2);
  return row === center && col === center;
}

export function rowWave3NormFromRow(row: number): number {
  return row / (MATRIX_SIZE_3 - 1);
}

export function colWave3NormFromCol(col: number): number {
  return col / (MATRIX_SIZE_3 - 1);
}

export function colWave3NormFromColReverse(col: number): number {
  return (MATRIX_SIZE_3 - 1 - col) / (MATRIX_SIZE_3 - 1);
}

export function wave3PathOpacityFromNorm(
  norm: number,
  base = 0.06,
  mid = 0.38,
  peak = 0.88
): number {
  const t = Math.min(1, Math.max(0, norm));
  if (t <= 0.5) {
    return base + (t / 0.5) * (mid - base);
  }
  return mid + ((t - 0.5) / 0.5) * (peak - mid);
}

function getMatrix3Layout(
  size: number,
  dotSize: number,
  cellPadding?: number
): { gap: number; matrixSpan: number } {
  const n = MATRIX_SIZE_3;
  if (cellPadding != null) {
    const g = Math.max(0, cellPadding);
    const matrixSpan = dotSize * n + g * (n - 1);
    return { gap: g, matrixSpan };
  }
  const g = Math.max(0, Math.floor((size - dotSize * n) / (n - 1)));
  return { gap: g, matrixSpan: size };
}

interface DotMatrix3BaseProps extends DotMatrixCommonProps {
  phase: DotMatrixPhase;
  reducedMotion?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  animationResolver?: DotAnimationResolver;
}

export function DotMatrix3Base({
  scale: scaleProp,
  size: sizeProp = 24,
  dotSize: dotSizeProp = 3,
  color = "currentColor",
  colorPreset,
  speed = 1,
  ariaLabel = "Loading",
  className,
  pattern = "full",
  dotShape = "circle",
  muted = false,
  bloom = false,
  halo = 0,
  dotClassName,
  phase,
  reducedMotion = false,
  onMouseEnter,
  onMouseLeave,
  animationResolver,
  opacityBase = 0.06,
  opacityMid,
  opacityPeak,
  cellPadding = 1,
  boxSize,
  minSize
}: DotMatrix3BaseProps) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scaleProp);
  const patternIndexes = new Set(getPattern3Indexes(pattern));
  const safeSpeed = speed > 0 ? speed : 1;
  const speedScale = 1 / safeSpeed;
  const { gap, matrixSpan } = getMatrix3Layout(size, dotSize, cellPadding);
  const { outerDim, useWrapper } = resolveDmxBoxOuterDim({ boxSize, minSize });
  const boxScale = useWrapper && matrixSpan > 0 ? outerDim / matrixSpan : 1;
  const center = CENTER_3;
  const ob = clamp01Dmx(opacityBase);
  const om = clamp01Dmx(opacityMid);
  const op = clamp01Dmx(opacityPeak);
  const unit = dotSize + gap;
  const { resolvedColor, dotFill } = resolveDmxColorTokens(color, colorPreset);

  const dmxVarStyle = {
    width: matrixSpan,
    height: matrixSpan,
    "--dmx-speed": speedScale,
    ["--dmx-dot-size" as const]: `${dotSize}px`,
    ["--dmx-halo-level" as const]: halo,
    ["--dmx-dot-fill" as const]: dotFill,
    color: resolvedColor,
    ...(ob !== undefined && { ["--dmx-opacity-base" as const]: ob }),
    ...(om !== undefined && { ["--dmx-opacity-mid" as const]: om }),
    ...(op !== undefined && { ["--dmx-opacity-peak" as const]: op }),
    ...(useWrapper
      ? {
        transform: `scale(${boxScale})`,
        transformOrigin: "center center" as const
      }
      : { minWidth: minSize, minHeight: minSize })
  } as unknown as CSSProperties;

  const gridStyle = {
    gap,
    gridTemplateColumns: `repeat(${MATRIX_SIZE_3}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${MATRIX_SIZE_3}, minmax(0, 1fr))`
  };

  const dots = Array.from({ length: MATRIX_SIZE_3 * MATRIX_SIZE_3 }).map((_, index) => {
    const { row, col } = indexToCoord3(index);
    const isActive = patternIndexes.has(index);
    const distance = distanceFromCenter3(index);
    const angle = Math.atan2(row - center, col - center);
    const radiusNormalizedValue = Math.hypot(row - center, col - center) / MAX_RADIUS_3;
    const manhattan = manhattanDistance3(index);
    const deltaX = (col - center) * unit;
    const deltaY = (row - center) * unit;

    const animationState = animationResolver
      ? animationResolver({
        index,
        row,
        col,
        distanceFromCenter: distance,
        angleFromCenter: angle,
        radiusNormalized: radiusNormalizedValue,
        manhattanDistance: manhattan,
        phase,
        isActive,
        reducedMotion
      })
      : {};

    const resolvedAnimationStyle = animationState.style ? { ...animationState.style } : undefined;
    let isBloomDot = false;
    let stylePatch: CSSProperties | undefined = resolvedAnimationStyle;

    if (isActive) {
      const rawOpacity = stylePatch?.opacity;
      if (stylePatch != null && typeof rawOpacity === "number") {
        const remappedOpacity = remapOpacityToTriplet(rawOpacity, ob, om, op);
        stylePatch = { ...stylePatch, opacity: remappedOpacity };
        const parts = dmxDotBloomParts(true, rawOpacity, bloom, halo, ob, om, op);
        (stylePatch as CSSProperties & { "--dmx-bloom-level"?: number })["--dmx-bloom-level"] = parts.level;
        isBloomDot = parts.bloomDot;
      } else {
        const parts = dmxDotBloomParts(true, 0, bloom, halo, ob, om, op);
        if (parts.level > 0) {
          stylePatch = {
            ...(stylePatch ?? {}),
            ["--dmx-bloom-level" as const]: parts.level
          } as CSSProperties & { "--dmx-bloom-level"?: number };
        }
        isBloomDot = parts.bloomDot;
      }
    }

    const dotStyle = {
      width: dotSize,
      height: dotSize,
      "--dmx-distance": distance,
      "--dmx-row": row,
      "--dmx-col": col,
      "--dmx-x": `${deltaX}px`,
      "--dmx-y": `${deltaY}px`,
      "--dmx-angle": angle,
      "--dmx-radius": radiusNormalizedValue,
      "--dmx-manhattan": manhattan,
      ...stylePatch,
      ...(!isActive
        ? {
          opacity: 0,
          visibility: "hidden" as const,
          pointerEvents: "none" as const,
          animation: "none"
        }
        : {})
    } as CSSProperties;

    return (
      <span
        key={index}
        aria-hidden="true"
        className={cx(
          "dmx-dot",
          !isActive && "dmx-inactive",
          isBloomDot && "dmx-bloom-dot",
          dotClassName,
          animationState.className
        )}
        style={dotStyle}
      />
    );
  });

  const matrix = (
    <div
      className={cx(
        "dmx-root",
        "dmx-matrix-3",
        `dmx-dot-shape-${dotShape}`,
        muted && "dmx-muted",
        dmxBloomRootActive(bloom, halo) && "dmx-bloom",
        dmxBloomHaloSpreadClass(halo),
        !useWrapper && className
      )}
      style={dmxVarStyle}
    >
      <div className="dmx-grid" style={gridStyle}>{dots}</div>
    </div>
  );

  if (useWrapper) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={ariaLabel}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: outerDim,
          height: outerDim,
          minWidth: minSize,
          minHeight: minSize,
          overflow: "hidden"
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {matrix}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={cx(
        "dmx-root",
        "dmx-matrix-3",
        `dmx-dot-shape-${dotShape}`,
        muted && "dmx-muted",
        dmxBloomRootActive(bloom, halo) && "dmx-bloom",
        dmxBloomHaloSpreadClass(halo),
        className
      )}
      style={dmxVarStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="dmx-grid" style={gridStyle}>{dots}</div>
    </div>
  );
}

type NormFn = (ctx: Pick<DotAnimationContext, "row" | "col" | "index">) => number;

export function createPathWaveResolver(getPathNorm: NormFn): DotAnimationResolver {
  return ({ isActive, row, col, index, reducedMotion, phase }) => {
    if (!isActive) {
      return { className: "dmx-inactive" };
    }

    const path = getPathNorm({ row, col, index });
    const style = { "--dmx-path": path } as CSSProperties;

    if (reducedMotion || phase === "idle") {
      return {
        style: {
          ...style,
          opacity: 0.12 + path * 0.72
        }
      };
    }

    return { className: "dmx-path", style };
  };
}

type PathWaveComponentProps = DotMatrixCommonProps;

export function createPathWaveComponent(displayName: string, getPathNorm: NormFn) {
  const resolve = createPathWaveResolver(getPathNorm);

  function PathWaveComponent({
    pattern = "full",
    animated = true,
    hoverAnimated = false,
    speed = 1,
    ...rest
  }: PathWaveComponentProps) {
    const reducedMotion = usePrefersReducedMotion();
    const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
      animated: Boolean(animated && !reducedMotion),
      hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
      speed
    });
    return (
      <DotMatrixBase
        {...rest}
        speed={speed}
        pattern={pattern}
        animated={animated}
        phase={matrixPhase}
        reducedMotion={reducedMotion}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        animationResolver={resolve}
      />
    );
  }

  PathWaveComponent.displayName = displayName;
  return PathWaveComponent;
}

export function createDiagonalWave3Resolver(direction: DiagonalWave3Direction): DotAnimationResolver {
  return ({ isActive, index, reducedMotion, phase }) => {
    if (!isActive) {
      return { className: "dmx-inactive" };
    }

    const path = diagonalWave3PathNormFromIndex(index, direction);
    const style = { "--dmx-path": path } as CSSProperties;

    if (reducedMotion || phase === "idle") {
      return {
        style: {
          ...style,
          opacity: path * 0.88
        }
      };
    }

    return { className: "dmx-path-3", style };
  };
}

type DiagonalWave3ComponentProps = DotMatrixCommonProps;

export function createDiagonalWave3Component(
  displayName: string,
  direction: DiagonalWave3Direction
) {
  const resolve = createDiagonalWave3Resolver(direction);

  function DiagonalWave3Component({
    pattern = "full",
    animated = true,
    hoverAnimated = false,
    speed = 1.15,
    ...rest
  }: DiagonalWave3ComponentProps) {
    const reducedMotion = usePrefersReducedMotion();
    const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
      animated: Boolean(animated && !reducedMotion),
      hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
      speed
    });

    return (
      <DotMatrix3Base
        {...rest}
        speed={speed}
        pattern={pattern}
        animated={animated}
        phase={matrixPhase}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        reducedMotion={reducedMotion}
        animationResolver={resolve}
      />
    );
  }

  DiagonalWave3Component.displayName = displayName;
  return DiagonalWave3Component;
}

type Dotm3x3ComponentProps = DotMatrixCommonProps;

export function createDotm3x3Component(
  displayName: string,
  animationResolver: DotAnimationResolver,
  defaultSpeed = 1.15
) {
  function Dotm3x3Component({
    pattern = "full",
    dotShape = "circle",
    animated = true,
    hoverAnimated = false,
    speed = defaultSpeed,
    ...rest
  }: Dotm3x3ComponentProps) {
    const reducedMotion = usePrefersReducedMotion();
    const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
      animated: Boolean(animated && !reducedMotion),
      hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
      speed
    });

    return (
      <DotMatrix3Base
        {...rest}
        speed={speed}
        pattern={pattern}
        dotShape={dotShape}
        animated={animated}
        phase={matrixPhase}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        reducedMotion={reducedMotion}
        animationResolver={animationResolver}
      />
    );
  }

  Dotm3x3Component.displayName = displayName;
  return Dotm3x3Component;
}

const GLYPH_SPIN_BASE_OPACITY = 0.09;
const GLYPH_SPIN_PEAK_OPACITY = 0.88;
const GLYPH_SPIN_STEP_MS = 180;
const GLYPH_SPIN_ROTATION_STEPS = 4;
const GLYPH_SPIN_CYCLE_MS_BASE = GLYPH_SPIN_STEP_MS * GLYPH_SPIN_ROTATION_STEPS;

function glyphSpinSmoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

export function rotate3x3(pattern: readonly number[], turns: number): readonly number[] {
  const t = ((turns % GLYPH_SPIN_ROTATION_STEPS) + GLYPH_SPIN_ROTATION_STEPS) % GLYPH_SPIN_ROTATION_STEPS;
  if (t === 0) {
    return pattern;
  }

  let out = [...pattern];
  for (let k = 0; k < t; k += 1) {
    const next = new Array<number>(9).fill(0);
    for (let i = 0; i < 9; i += 1) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      const nr = c;
      const nc = 2 - r;
      next[nr * 3 + nc] = out[i]!;
    }
    out = next;
  }
  return out;
}

function glyphSpinOpacity(current: readonly number[], next: readonly number[], index: number, t: number): number {
  const weight = (current[index] ?? 0) * (1 - t) + (next[index] ?? 0) * t;
  return GLYPH_SPIN_BASE_OPACITY + weight * (GLYPH_SPIN_PEAK_OPACITY - GLYPH_SPIN_BASE_OPACITY);
}

type GlyphSpin3ComponentProps = DotMatrixCommonProps;

export function createGlyphSpin3Component(
  displayName: string,
  glyph: readonly number[],
  defaultSpeed = 1
) {
  function GlyphSpin3Component({
    speed = defaultSpeed,
    pattern = "full",
    dotShape = "circle",
    animated = true,
    hoverAnimated = false,
    ...rest
  }: GlyphSpin3ComponentProps) {
    const reducedMotion = usePrefersReducedMotion();
    const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
      animated: Boolean(animated && !reducedMotion),
      hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
      speed
    });
    const cyclePhase = useCyclePhase({
      active: !reducedMotion && matrixPhase !== "idle",
      cycleMsBase: GLYPH_SPIN_CYCLE_MS_BASE,
      speed
    });

    const animationResolver = useMemo<DotAnimationResolver>(() => {
      const scaledPhase = cyclePhase * GLYPH_SPIN_ROTATION_STEPS;
      const turns = Math.floor(scaledPhase) % GLYPH_SPIN_ROTATION_STEPS;
      const segmentT = glyphSpinSmoothstep(scaledPhase - Math.floor(scaledPhase));
      const current = rotate3x3(glyph, turns);
      const next = rotate3x3(glyph, turns + 1);

      return ({ isActive, index, reducedMotion: rm, phase }) => {
        if (!isActive) {
          return { className: "dmx-inactive" };
        }

        if (rm || phase === "idle") {
          return { style: { opacity: glyphSpinOpacity(glyph, glyph, index, 0) } };
        }

        return { style: { opacity: glyphSpinOpacity(current, next, index, segmentT) } };
      };
    }, [cyclePhase]);

    return (
      <DotMatrix3Base
        {...rest}
        speed={speed}
        pattern={pattern}
        dotShape={dotShape}
        animated={animated}
        phase={matrixPhase}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        reducedMotion={reducedMotion}
        animationResolver={animationResolver}
      />
    );
  }

  GlyphSpin3Component.displayName = displayName;
  return GlyphSpin3Component;
}

