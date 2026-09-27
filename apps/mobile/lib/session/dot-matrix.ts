/**
 * The session busy-indicator glyph catalog — a React-free port of apps/web
 * `components/ui/dot-matrix/session-dot-matrix.tsx` and the 52 variant files
 * it lists (`dotm-3x3-*`, `dotm-circular-*`, `dotm-square-*`).
 *
 * Each variant is `frame(elapsedMs, still)`: the opacity of every cell at that
 * moment, `null` for a hidden cell (web `dmx-inactive`). `still` is reduced
 * motion — web's `phase === 'idle'` branch. Speeds, cycle lengths, masks, and
 * opacity constants are copied from the web file named in each entry.
 *
 * `sessionDotMatrixIndex` is web's FNV-1a over the session id, so a session
 * shows the SAME glyph on web and mobile. Catalog order is pinned against the
 * web source by `dot-matrix.test.ts`.
 *
 * No React / React Native import.
 */

import {
  CELLS_3,
  CELLS_5,
  CSS,
  GLYPH_SPIN_CYCLE_MS_BASE,
  VARS_3,
  VARS_5,
  cssDotOpacity,
  cubicBezier,
  cyclePhase,
  diagonalSnakeNormFromIndex,
  diagonalSnakeOrderValue,
  diagonalWave3PathNormFromIndex,
  glyphSpinOpacity,
  glyphSpinSmoothstep,
  isWithinCircularMask,
  middleRingAntiClockwiseNormFromIndex,
  middleRingAntiClockwiseOrderValue,
  outerRingClockwise3NormFromIndex,
  outerRingClockwise3OrderValue,
  outerRingClockwiseNormFromIndex,
  outerRingClockwiseOrderValue,
  remapOpacityToTriplet,
  rotate3x3,
  rowMajorIndex,
  snakePath3NormFromIndex,
  snakePath3OrderValue,
  spiralInwardNormFromIndex,
  spiralInwardOrderValue,
  steppedCycle,
  steppedCycleStepMs,
  trBlPathNormFromIndex,
  wave3PathOpacityFromNorm,
  type CssAnimation,
  type DiagonalWave3Direction,
  type DotCell,
  type GridSize,
} from './dot-matrix-core';

export { cubicBezier, remapOpacityToTriplet } from './dot-matrix-core';

export type DotMatrixFamily = '3x3' | 'circular' | 'square';
export type DotFrame = ReadonlyArray<number | null>;

export interface DotMatrixVariant {
  name: string;
  family: DotMatrixFamily;
  grid: GridSize;
  /** The web component's default `speed`. */
  speed: number;
  frame(elapsedMs: number, still: boolean): DotFrame;
}

/** A resolver's answer for one cell: hidden, an inline opacity, or a CSS animation. */
type Resolved = null | number | { css: CssAnimation; delay: number };

interface Clock {
  t: number;
  still: boolean;
  speed: number;
}

function css(animation: CssAnimation, delay = 0): Resolved {
  return { css: animation, delay };
}

/**
 * Web `DotMatrixBase` / `DotMatrix3Base`: inline opacities are remapped
 * (3×3 base 0.06; 5×5 clamps), CSS dots read the grid's opacity variables.
 */
function variant<S>(spec: {
  name: string;
  family: DotMatrixFamily;
  speed: number;
  prepare?: (clock: Clock) => S;
  resolve: (cell: DotCell, state: S, clock: Clock) => Resolved;
}): DotMatrixVariant {
  const grid: GridSize = spec.family === '3x3' ? 3 : 5;
  const cells = grid === 3 ? CELLS_3 : CELLS_5;
  const vars = grid === 3 ? VARS_3 : VARS_5;
  const opacityBase = grid === 3 ? 0.06 : undefined;
  return {
    name: spec.name,
    family: spec.family,
    grid,
    speed: spec.speed,
    frame(elapsedMs, still) {
      const clock: Clock = { t: Math.max(0, elapsedMs), still, speed: spec.speed };
      const state = spec.prepare ? spec.prepare(clock) : (undefined as S);
      return cells.map((cell) => {
        const resolved = spec.resolve(cell, state, clock);
        if (resolved === null) return null;
        if (typeof resolved === 'number') return remapOpacityToTriplet(resolved, opacityBase);
        return cssDotOpacity(resolved.css, resolved.delay, clock.t, clock.speed, vars);
      });
    },
  };
}

// ─── 3×3 ─────────────────────────────────────────────────────────────────────

/** `createDiagonalWave3Component` (dotm-3x3-2…5), speed 1.15. */
function diagonalWave3(name: string, direction: DiagonalWave3Direction): DotMatrixVariant {
  return variant({
    name,
    family: '3x3',
    speed: 1.15,
    resolve: ({ index }, _s, { still }) => {
      const path = diagonalWave3PathNormFromIndex(index, direction);
      return still ? path * 0.88 : css(CSS.path3, path * 0.19);
    },
  });
}

/** `createGlyphSpin3Component` (dotm-3x3-16, 18–21), speed 1. */
function glyphSpin3(name: string, glyph: readonly number[]): DotMatrixVariant {
  return variant({
    name,
    family: '3x3',
    speed: 1,
    prepare: ({ t, still, speed }) => {
      const scaled = cyclePhase(t, !still, GLYPH_SPIN_CYCLE_MS_BASE, speed) * 4;
      const turns = Math.floor(scaled) % 4;
      return {
        current: rotate3x3(glyph, turns),
        next: rotate3x3(glyph, turns + 1),
        segmentT: glyphSpinSmoothstep(scaled - Math.floor(scaled)),
      };
    },
    resolve: ({ index }, { current, next, segmentT }, { still }) =>
      still ? glyphSpinOpacity(glyph, glyph, index, 0) : glyphSpinOpacity(current, next, index, segmentT),
  });
}

const DOTM_3X3: readonly DotMatrixVariant[] = [
  diagonalWave3('dotm-3x3-2', 'tr-bl'),
  diagonalWave3('dotm-3x3-3', 'tl-br'),
  diagonalWave3('dotm-3x3-4', 'br-tl'),
  diagonalWave3('dotm-3x3-5', 'bl-tr'),
  variant({
    name: 'dotm-3x3-6',
    family: '3x3',
    speed: 1.75,
    resolve: ({ manhattanDistance }, _s, { still }) => {
      const ring = Math.max(0, Math.min(2, manhattanDistance));
      return still ? 0.06 + (1 - ring / 2) * 0.82 : css(CSS.centerRipple3, ring * 0.11);
    },
  }),
  variant({
    name: 'dotm-3x3-7',
    family: '3x3',
    speed: 1.75,
    resolve: ({ col }, _s, { still }) => {
      const path = col / 2;
      return still ? wave3PathOpacityFromNorm(path) : css(CSS.path3, path * 0.19);
    },
  }),
  variant({
    name: 'dotm-3x3-8',
    family: '3x3',
    speed: 1.75,
    resolve: ({ row }, _s, { still }) => {
      const path = row / 2;
      return still ? wave3PathOpacityFromNorm(path) : css(CSS.path3, path * 0.19);
    },
  }),
  variant({
    name: 'dotm-3x3-9',
    family: '3x3',
    speed: 1.75,
    resolve: ({ index }, _s, { still }) =>
      still
        ? wave3PathOpacityFromNorm(snakePath3NormFromIndex(index))
        : css(CSS.snakePath3, snakePath3OrderValue(index) * 0.085),
  }),
  variant({
    name: 'dotm-3x3-10',
    family: '3x3',
    speed: 1.75,
    resolve: ({ index, row, col }, _s, { still }) => {
      if (row === 1 && col === 1) return still ? 0.2 : css(CSS.corePulse3);
      return still
        ? wave3PathOpacityFromNorm(outerRingClockwise3NormFromIndex(index))
        : css(CSS.frameChase3, outerRingClockwise3OrderValue(index) * 0.09);
    },
  }),
  variant({
    name: 'dotm-3x3-12',
    family: '3x3',
    speed: 1.75,
    resolve: ({ distanceFromCenter }, _s, { still }) => {
      const ring = Math.max(0, Math.min(2, Math.round(distanceFromCenter)));
      return still ? 0.06 + (1 - ring / 2) * 0.82 : css(CSS.distanceRipple3, distanceFromCenter * 0.13);
    },
  }),
  variant({
    name: 'dotm-3x3-13',
    family: '3x3',
    speed: 1.75,
    resolve: ({ col }, _s, { still }) => {
      const path = (2 - col) / 2;
      return still ? wave3PathOpacityFromNorm(path) : css(CSS.path3, path * 0.19);
    },
  }),
  variant({
    name: 'dotm-3x3-15',
    family: '3x3',
    speed: 1.75,
    resolve: ({ manhattanDistance }, _s, { still }) => {
      const ring = Math.max(0, Math.min(2, manhattanDistance));
      return still ? 0.06 + (1 - ring / 2) * 0.82 : css(CSS.rippleEcho3, ring * 0.1 + (ring % 2) * 0.02);
    },
  }),
  glyphSpin3('dotm-3x3-16', [1, 0, 1, 0, 0, 0, 0, 1, 0]),
  glyphSpin3('dotm-3x3-18', [0, 0, 1, 0, 1, 0, 1, 0, 0]),
  glyphSpin3('dotm-3x3-19', [0, 1, 0, 0, 1, 1, 0, 1, 0]),
  glyphSpin3('dotm-3x3-20', [1, 1, 0, 1, 0, 0, 1, 0, 0]),
  glyphSpin3('dotm-3x3-21', [1, 0, 0, 1, 1, 0, 1, 0, 0]),
];

// ─── Circular (5×5, corners masked) ──────────────────────────────────────────

/** A circular variant driven by `useCyclePhase`. `opacity` gets phase 0 when still. */
function circularCycle(
  name: string,
  speed: number,
  cycleMsBase: number,
  opacity: (cell: DotCell, phase: number, still: boolean) => number,
): DotMatrixVariant {
  return variant({
    name,
    family: 'circular',
    speed,
    prepare: ({ t, still }) => cyclePhase(t, !still, cycleMsBase, speed),
    resolve: (cell, phase, { still }) => (isWithinCircularMask(cell.row, cell.col) ? opacity(cell, phase, still) : null),
  });
}

/** A circular variant driven by `useSteppedCycle`. */
function circularStepped(
  name: string,
  speed: number,
  cycleMsBase: number,
  steps: number,
  idleStep: number,
  opacity: (cell: DotCell, step: number, still: boolean) => number,
): DotMatrixVariant {
  return variant({
    name,
    family: 'circular',
    speed,
    prepare: ({ t, still }) => steppedCycle(t, !still, cycleMsBase, steps, speed, idleStep),
    resolve: (cell, step, { still }) => (isWithinCircularMask(cell.row, cell.col) ? opacity(cell, step, still) : null),
  });
}

const CIRCULAR_RING_PATH: readonly number[] = [
  rowMajorIndex(0, 1), rowMajorIndex(0, 2), rowMajorIndex(0, 3), rowMajorIndex(1, 4),
  rowMajorIndex(2, 4), rowMajorIndex(3, 4), rowMajorIndex(4, 3), rowMajorIndex(4, 2),
  rowMajorIndex(4, 1), rowMajorIndex(3, 0), rowMajorIndex(2, 0), rowMajorIndex(1, 0),
];

const COMET_TAIL = [1, 0.78, 0.56, 0.36, 0.22] as const;

function moduloDistance(a: number, b: number, mod: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, mod - raw);
}

const BRAILLE_PHASES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['1,1', '2,1', '3,1', '1,3', '2,3', '3,3']),
  new Set(['1,1', '2,1', '3,1', '2,2', '1,3', '2,3', '3,3']),
  new Set(['1,1', '1,2', '1,3', '2,1', '2,3', '3,1', '3,2', '3,3']),
  new Set(['1,1', '3,1', '2,2', '1,3', '3,3']),
  new Set(['2,1', '1,2', '3,2', '2,3']),
  new Set(['1,1', '2,1', '2,2', '2,3', '3,3']),
];

const DOTM_CIRCULAR: readonly DotMatrixVariant[] = [
  circularCycle('dotm-circular-1', 2.5, 1700, ({ row, col }, phase, still) => {
    const t = still ? 0 : phase * 20;
    const phaseOffset = t * ((Math.PI * 2) / 19) + (row + col) * 0.82;
    const strand = Math.round(2 * Math.sin(phaseOffset));
    const distance = Math.abs(col - row - strand);
    if (distance === 0) return 1;
    if (distance === 1) return 0.24;
    return 0.08;
  }),
  variant({
    name: 'dotm-circular-2',
    family: 'circular',
    speed: 1.8,
    resolve: ({ index, row, col }, _s, { still }) => {
      if (!isWithinCircularMask(row, col)) return null;
      const onRing = CIRCULAR_RING_PATH.indexOf(index);
      if (onRing === -1) return row === 2 && col === 2 ? 0.18 : 0.08;
      if (still) return 0.28 + (onRing / 11) * 0.58;
      return css(CSS.circular2Ring, onRing * 0.0833333333);
    },
  }),
  circularStepped('dotm-circular-3', 1.6, 1650, 24, 6, ({ index, row, col }, headStep, still) => {
    const pathOrder = CIRCULAR_RING_PATH.indexOf(index);
    if (pathOrder === -1) return row === 2 && col === 2 ? 0.16 : 0.08;
    if (still) return 0.2 + (pathOrder / 11) * 0.56;
    const leadA = Math.floor((headStep / 24) * 12) % 12;
    const leadB = (leadA + 6) % 12;
    let opacity = 0.08;
    for (let i = 0; i < COMET_TAIL.length; i += 1) {
      const weight = COMET_TAIL[i] ?? 0;
      if (pathOrder === (leadA - i + 12) % 12) opacity = Math.max(opacity, weight);
      if (pathOrder === (leadB - i + 12) % 12) opacity = Math.max(opacity, weight * 0.72);
    }
    return Math.min(1, opacity);
  }),
  circularCycle('dotm-circular-4', 1.55, 1800, ({ row, col }, phase, still) => {
    const centerRow = row - 2;
    const centerCol = col - 2;
    const radius = Math.hypot(centerRow, centerCol);
    const theta = (still ? 0 : phase) * Math.PI * 2;
    const sweepX = Math.cos(theta);
    const sweepY = Math.sin(theta);
    const projection = centerCol * sweepX + centerRow * sweepY;
    const perpendicular = Math.abs(centerCol * sweepY - centerRow * sweepX);
    if (radius < 0.5) return 0.62;
    if (projection > 0.3 && perpendicular < 0.55) return 0.96;
    if (projection > 0 && perpendicular < 1.15) return 0.36;
    if (radius > 1.6 && radius < 2.3) return 0.22;
    return 0.08;
  }),
  circularCycle('dotm-circular-5', 1.7, 1650, ({ row, col }, phase, still) => {
    const x = col - 2;
    const y = row - 2;
    const radius = Math.hypot(x, y);
    const angle = Math.atan2(y, x);
    const theta = (still ? 0 : phase) * Math.PI * 2;
    const pinwheel = Math.cos(angle * 4 - theta * 2.2);
    const radialGate = Math.sin(radius * 2.1 - theta * 1.25);
    if (radius < 0.6) return 0.66;
    if (pinwheel > 0.48 && radialGate > -0.25) return 0.94;
    if (pinwheel > 0.1) return 0.34;
    return 0.08;
  }),
  circularCycle('dotm-circular-6', 1.6, 1700, ({ row, col }, phase, still) => {
    const x = col - 2;
    const y = row - 2;
    const t = still ? 0 : phase * Math.PI * 2;
    const angle = Math.atan2(y, x);
    const ring = Math.sqrt(x * x + y * y);
    const angularPhase = ((angle - t * 0.95 + Math.PI * 4) % (Math.PI * 2)) / ((Math.PI * 2) / 3);
    const sectorPos = angularPhase - Math.floor(angularPhase);
    const sectorPulse = Math.max(0, 1 - Math.abs(sectorPos - 0.5) * 2);
    const ringPhase = 0.5 + 0.5 * Math.cos(ring * 3.2 + t * 1.7);
    const score = 0.74 * sectorPulse + 0.26 * ringPhase;
    let opacity = 0.08;
    if (score > 0.84) opacity = 0.96;
    else if (score > 0.63) opacity = 0.62;
    else if (score > 0.44) opacity = 0.34;
    return x === 0 && y === 0 ? Math.max(opacity, 0.34) : opacity;
  }),
  circularCycle('dotm-circular-7', 1.8, 1600, ({ row, col }, phase, still) => {
    const x = col - 2;
    const y = row - 2;
    const t = still ? 0 : phase * Math.PI * 2;
    const ring = Math.sqrt(x * x + y * y);
    const angle = Math.atan2(y, x);
    const petalWave = 0.5 + 0.5 * Math.cos(5 * angle - t * 1.7);
    const ringWave = 0.5 + 0.5 * Math.cos(ring * 3.3 - t * 1.2);
    const chordWave = 0.5 + 0.5 * Math.cos((x + y) * 1.6 + t * 1.35);
    const blend = 0.68 * Math.pow(petalWave, 2.2) + 0.22 * ringWave + 0.1 * chordWave;
    return 0.08 + (0.92 - 0.08) * blend;
  }),
  circularCycle('dotm-circular-8', 1.95, 1400, ({ row, col }, phase, still) => {
    const radius = Math.hypot(col - 2, row - 2);
    const beat = still ? 0 : Math.sin(phase * Math.PI * 2);
    const spike = still ? 0 : Math.sin(phase * Math.PI * 4);
    const pulse = Math.max(0, beat) + Math.max(0, spike) * 0.55;
    if (radius < 0.55) return Math.min(1, 0.35 + pulse * 0.95);
    if (radius < 1.65) return 0.16 + pulse * 0.44;
    return 0.08 + pulse * 0.08;
  }),
  circularStepped('dotm-circular-9', 5.55, 1900, 36, 0, ({ row, col }, step) => {
    const x = col - 2;
    const y = row - 2;
    const ring = Math.sqrt(x * x + y * y);
    const angle = Math.atan2(y, x);
    const cardinalCenters = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const beaconIndex = Math.floor((step / 36) * 4) % 4;
    const activeBeam = Math.max(0, 1 - Math.acos(Math.cos(angle - cardinalCenters[beaconIndex]!)) / 0.5);
    const oppositeBeam = Math.max(0, 1 - Math.acos(Math.cos(angle - cardinalCenters[(beaconIndex + 2) % 4]!)) / 0.65);
    const ringTier = Math.round(ring);
    let opacity = 0.07;
    if (activeBeam > 0.8 && ringTier >= 2) opacity = 0.96;
    else if (activeBeam > 0.45 && ringTier >= 1) opacity = 0.62;
    else if (oppositeBeam > 0.5 && ringTier >= 1) opacity = 0.28;
    return x === 0 && y === 0 ? Math.max(opacity, 0.24) : opacity;
  }),
  circularCycle('dotm-circular-10', 1.75, 1600, ({ row, col }, phase, still) => {
    const x = col - 2;
    const y = row - 2;
    const ring = Math.round(Math.sqrt(x * x + y * y));
    const tick = still ? 0 : Math.floor(phase * 10);
    const d = moduloDistance((row * 3 + col * 5 + ring * 2) % 10, tick, 10);
    const parityGate = (row + col + tick) % 2 === 0;
    let opacity = 0.06;
    if (d === 0) opacity = 0.94;
    else if (d === 1) opacity = 0.48;
    else if (d === 2 || parityGate) opacity = 0.2;
    return x === 0 && y === 0 ? Math.max(opacity, 0.48) : opacity;
  }),
  circularCycle('dotm-circular-11', 1.65, 1850, ({ row, col }, phase, still) => {
    const x = col - 2;
    const y = row - 2;
    const ring = Math.sqrt(x * x + y * y);
    const t = still ? 0 : phase * Math.PI * 2;
    const angle = Math.atan2(y, x);
    const moonCenterX = Math.cos(t) * 0.7;
    const moonCenterY = Math.sin(t) * 0.7;
    const body = Math.hypot(x - moonCenterX, y - moonCenterY);
    const cut = Math.hypot(x - (moonCenterX + Math.cos(t) * 0.82), y - (moonCenterY + Math.sin(t) * 0.82));
    const rim = Math.max(0, 1 - Math.abs(body - 1.55) / 0.35);
    const halo = Math.max(0, 1 - Math.acos(Math.cos(angle - t)) / 0.9);
    let opacity = 0.07;
    if (body < 1.55 && cut > 1.05) opacity = 0.95;
    else if (rim > 0.5) opacity = 0.3 + rim * 0.22;
    else if (halo > 0.68 && ring > 1.2) opacity = 0.3;
    return Math.min(0.95, opacity);
  }),
  circularStepped('dotm-circular-12', 1.7, 1700, 36, 0, ({ row, col }, step) => {
    const x = col - 2;
    const y = row - 2;
    const ring = Math.sqrt(x * x + y * y);
    const angle = Math.atan2(y, x);
    const targetAngle = (Math.floor((step / 36) * 8) % 8) * (Math.PI / 4);
    const beam = Math.max(0, 1 - Math.acos(Math.cos(angle - targetAngle)) / 0.42);
    const oppositeBeam = Math.max(0, 1 - Math.acos(Math.cos(angle - (targetAngle + Math.PI))) / 0.62);
    const spokePulse = Math.max(0, 1 - Math.abs(Math.abs(x) - Math.abs(y)) / 0.35);
    const ringTier = ring < 1 ? 0 : ring < 2 ? 1 : 2;
    let opacity = 0.06;
    if (beam > 0.78 && ringTier >= 1) opacity = 0.96;
    else if (beam > 0.48) opacity = 0.62;
    else if (oppositeBeam > 0.52 && ringTier === 2) opacity = 0.3;
    else if (spokePulse > 0.9 && ringTier > 0) opacity = 0.3;
    return x === 0 && y === 0 ? Math.max(opacity, 0.26) : opacity;
  }),
  circularCycle('dotm-circular-14', 1.75, 1650, ({ row, col }, phase, still) => {
    const x = col - 2;
    const y = row - 2;
    const phaseStep = still ? 0 : Math.floor(phase * 10);
    const activeRow = (phaseStep + 5) % 5;
    const rowDistance = Math.abs(row - activeRow);
    const swing = Math.sin((phaseStep / 10) * Math.PI * 2 + y * 0.9);
    const leftAnchor = Math.round(1 + swing);
    const rightAnchor = 4 - leftAnchor;
    let opacity = 0.07;
    if (row === activeRow && col >= leftAnchor && col <= rightAnchor) opacity = 0.95;
    else if ((col === leftAnchor || col === rightAnchor) && rowDistance <= 1) opacity = 0.56;
    else if ((col === leftAnchor || col === rightAnchor) && rowDistance === 2) opacity = 0.28;
    return x === 0 && y === 0 && rowDistance <= 1 ? Math.max(opacity, 0.56) : opacity;
  }),
  circularCycle('dotm-circular-15', 1.65, 1680, ({ row, col }, phase, still) => {
    const ring = Math.sqrt((col - 2) ** 2 + (row - 2) ** 2);
    const count = BRAILLE_PHASES.length;
    const phaseIndex = still ? 0 : (((Math.floor((Number.isFinite(phase) ? phase : 0) * count)) % count) + count) % count;
    const key = `${row},${col}`;
    if (BRAILLE_PHASES[phaseIndex]!.has(key)) return 0.95;
    if (BRAILLE_PHASES[(phaseIndex + count - 1) % count]!.has(key)) return 0.34;
    if (ring < 1.1) return 0.2;
    return 0.07;
  }),
  circularCycle('dotm-circular-17', 1.55, 1500, ({ row, col }, phase, still) => {
    const t = still ? 0 : Math.floor(phase * 4) % 4;
    const parity = (row + col + t) % 2;
    const brailleBias = col === 1 || col === 3;
    const centerBias = row === 2 || col === 2;
    if (parity === 0 && brailleBias) return 0.95;
    if (parity === 0 || centerBias) return 0.34;
    if (brailleBias) return 0.24;
    return 0.07;
  }),
];

// ─── Square (5×5, full) ──────────────────────────────────────────────────────

function squareCycle(
  name: string,
  speed: number,
  cycleMsBase: number,
  opacity: (cell: DotCell, phase: number, still: boolean) => number,
): DotMatrixVariant {
  return variant({
    name,
    family: 'square',
    speed,
    prepare: ({ t, still }) => cyclePhase(t, !still, cycleMsBase, speed),
    resolve: (cell, phase, { still }) => opacity(cell, phase, still),
  });
}

function squareStepped(
  name: string,
  speed: number,
  cycleMsBase: number,
  steps: number,
  idleStep: number,
  opacity: (cell: DotCell, step: number, still: boolean) => number,
): DotMatrixVariant {
  return variant({
    name,
    family: 'square',
    speed,
    prepare: ({ t, still }) => steppedCycle(t, !still, cycleMsBase, steps, speed, idleStep),
    resolve: (cell, step, { still }) => opacity(cell, step, still),
  });
}

function maskOpacity(mask: string, row: number, col: number, values: Readonly<Record<string, number>>): number {
  return values[mask[rowMajorIndex(row, col)] ?? '.'] ?? values['.']!;
}

const SQUARE2_ROUTE: readonly number[] = (() => {
  const path: number[] = [];
  const push = (row: number, col: number) => path.push(rowMajorIndex(row, col));
  for (let row = 4; row >= 0; row -= 1) push(row, 0);
  push(0, 1);
  push(0, 2);
  for (let row = 1; row <= 4; row += 1) push(row, 2);
  push(4, 1);
  for (let row = 3; row >= 0; row -= 1) push(row, 1);
  push(0, 2);
  push(0, 3);
  for (let row = 1; row <= 4; row += 1) push(row, 3);
  push(4, 2);
  for (let row = 3; row >= 0; row -= 1) push(row, 2);
  push(0, 3);
  push(0, 4);
  for (let row = 1; row <= 4; row += 1) push(row, 4);
  return path;
})();

const SQUARE2_VISITS: ReadonlyMap<number, readonly number[]> = (() => {
  const visits = new Map<number, number[]>();
  SQUARE2_ROUTE.forEach((index, step) => visits.set(index, [...(visits.get(index) ?? []), step]));
  return visits;
})();

const SQUARE2_TAIL = [1, 0.82, 0.68, 0.54, 0.42, 0.31, 0.22, 0.14] as const;

const SQUARE7_MASKS: readonly string[] = [
  ['.....', '.....', '.....', '.....', 'ooooo'],
  ['.....', '.....', '.....', 'ooooo', 'ooooo'],
  ['.....', '.....', 'ooooo', 'ooooo', 'ooooo'],
  ['.....', 'ooooo', 'ooooo', 'ooooo', 'ooooo'],
  ['ooooo', 'ooooo', 'ooooo', 'ooooo', 'ooooo'],
  ['ccccc', 'ccccc', 'ccccc', 'ccccc', 'ccccc'],
  ['.....', '.....', '.....', '.....', '.....'],
  ['ccccc', 'ccccc', 'ccccc', 'ccccc', 'ccccc'],
  ['.....', '.....', '.....', '.....', '.....'],
  ['.....', '.....', '.....', '.....', '.....'],
].map((rows) => rows.join(''));
const SQUARE7_SEQUENCE: readonly number[] = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9];

const SQUARE8_FILL_LAST = 9;
const SQUARE8_SEQUENCE_LEN = SQUARE8_FILL_LAST + 1 + 4 + SQUARE8_FILL_LAST + 1;
const SQUARE8_BLINK = [0.38, 1, 0.38, 1] as const;

const D1 = 0x01;
const D2 = 0x02;
const D3 = 0x04;
const D4 = 0x08;
const D5 = 0x10;
const D6 = 0x20;
const CHECK_A = D1 | D3 | D5;

function brailleBit(row: number, col: number): number | null {
  if (row < 1 || row > 3) return null;
  const dr = row - 1;
  if (col === 0 || col === 3) return D1 << dr;
  if (col === 1 || col === 4) return D4 << dr;
  return null;
}

const SQUARE13_MASKS: readonly string[] = [
  ['..x..', '..x..', '..o..', '.....', '.....'], // N
  ['....x', '...x.', '..o..', '.....', '.....'], // NE
  ['.....', '.....', '..oxx', '.....', '.....'], // E
  ['.....', '.....', '..o..', '...x.', '....x'], // SE
  ['.....', '.....', '..o..', '..x..', '..x..'], // S
  ['.....', '.....', '..o..', '.x...', 'x....'], // SW
  ['.....', '.....', 'xxo..', '.....', '.....'], // W
  ['x....', '.x...', '..o..', '.....', '.....'], // NW
].map((rows) => rows.join(''));
const SQUARE13_SEQUENCE: readonly number[] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];

const SQUARE14_MASKS: readonly string[] = [
  ['x...x', '.x.x.', '..o..', '.x.x.', 'x...x'], // diagonal star
  ['..x..', '.oxo.', 'xooox', '.oxo.', '..x..'], // diamond bloom
  ['.x.x.', 'x.o.x', '..o..', 'x.o.x', '.x.x.'], // petal ring
  ['x.x.x', '.o.o.', 'x.o.x', '.o.o.', 'x.x.x'], // crossed lattice
].map((rows) => rows.join(''));
const SQUARE14_SEQUENCE: readonly number[] = [0, 1, 2, 3, 2, 1];
const SQUARE14_VALUES = { x: 1, o: 0.52, '.': 0.08 } as const;
/** `transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1)` on every dot. */
const SQUARE14_TRANSITION_MS = 180;
const SQUARE14_TRANSITION_EASE = cubicBezier(0.4, 0, 0.2, 1);

const SQUARE19_CURVE: ReadonlyArray<{ x: number; y: number }> = Array.from({ length: 96 }, (_, i) => {
  const t = (i / 96) * Math.PI * 2;
  return { x: Math.sin(t), y: 0.58 * Math.sin(2 * t) };
});

function square19LoopPoint(step: number): { x: number; y: number } {
  const t = ((step % 48) / 48) * Math.PI * 2;
  return { x: Math.sin(t), y: 0.58 * Math.sin(2 * t) };
}

function squaredDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

const SQUARE20_PERIMETER: readonly number[] = [
  rowMajorIndex(0, 0), rowMajorIndex(0, 1), rowMajorIndex(0, 2), rowMajorIndex(0, 3),
  rowMajorIndex(0, 4), rowMajorIndex(1, 4), rowMajorIndex(2, 4), rowMajorIndex(3, 4),
  rowMajorIndex(4, 4), rowMajorIndex(4, 3), rowMajorIndex(4, 2), rowMajorIndex(4, 1),
  rowMajorIndex(4, 0), rowMajorIndex(3, 0), rowMajorIndex(2, 0), rowMajorIndex(1, 0),
];
const SQUARE20_TAIL = [1, 0.82, 0.64, 0.46, 0.3, 0.18] as const;
const SQUARE20_BACK_TAIL = [0.38, 0.3, 0.22, 0.14] as const;
const SQUARE20_TWIST: ReadonlyMap<number, number> = new Map([
  [0, rowMajorIndex(1, 1)],
  [4, rowMajorIndex(1, 3)],
  [8, rowMajorIndex(3, 3)],
  [12, rowMajorIndex(3, 1)],
]);

function tailOpacity(distance: number, tail: readonly number[]): number {
  return distance < 0 || distance >= tail.length ? 0 : tail[distance]!;
}

/** Helix strand columns shared by square-15/16. */
function helixOpacity(col: number, left: number, rowPhase: number): number {
  const right = 4 - left;
  if (col === left || col === right) return 1;
  if (Math.cos(rowPhase * 2) > 0.82 && col > left && col < right) return 0.58;
  if (Math.abs(col - left) === 1 || Math.abs(col - right) === 1) return 0.24;
  return 0.08;
}

const square14Base = squareStepped('dotm-square-14', 1.25, 1700, 6, 0, ({ row, col }, step) =>
  maskOpacity(SQUARE14_MASKS[SQUARE14_SEQUENCE[step] ?? 0]!, row, col, SQUARE14_VALUES),
);

/** dotm-square-14 plus its per-dot 180ms opacity transition between frames. */
const square14: DotMatrixVariant = {
  ...square14Base,
  frame(elapsedMs, still) {
    const target = square14Base.frame(elapsedMs, still);
    if (still) return target;
    const stepMs = steppedCycleStepMs(1700, 6, square14Base.speed);
    const t = Math.max(0, elapsedMs);
    const since = t % stepMs;
    // The first frame after mount has nothing to transition from.
    if (t < stepMs || since >= SQUARE14_TRANSITION_MS) return target;
    const previous = square14Base.frame(t - since - stepMs / 2, false);
    const eased = SQUARE14_TRANSITION_EASE(since / SQUARE14_TRANSITION_MS);
    return target.map((value, i) => {
      const from = previous[i];
      if (value === null || from === null || from === undefined) return value;
      return from + (value - from) * eased;
    });
  },
};

const DOTM_SQUARE: readonly DotMatrixVariant[] = [
  variant({
    name: 'dotm-square-1',
    family: 'square',
    speed: 1.1,
    resolve: ({ index, row, col }, _s, { still }) => {
      const path = trBlPathNormFromIndex(index);
      const parity = (row + (4 - col)) % 2;
      if (still) return parity === 0 ? 0.88 : 0.14;
      return css(CSS.diagonalAltSweep, path * 0.2 + parity * 0.5);
    },
  }),
  squareStepped('dotm-square-2', 1.15, 1500, SQUARE2_ROUTE.length, 0, ({ index }, head) => {
    const routeLen = SQUARE2_ROUTE.length;
    let opacity = 0.08;
    for (const stepIndex of SQUARE2_VISITS.get(index) ?? []) {
      const distance = (head - stepIndex + routeLen) % routeLen;
      if (distance >= 0 && distance < SQUARE2_TAIL.length) opacity = Math.max(opacity, SQUARE2_TAIL[distance]!);
    }
    return opacity;
  }),
  variant({
    name: 'dotm-square-3',
    family: 'square',
    speed: 1.35,
    resolve: ({ index }, _s, { still }) =>
      still ? 0.16 + spiralInwardNormFromIndex(index) * 0.78 : css(CSS.spiralSnake, spiralInwardOrderValue(index) * 0.04),
  }),
  variant({
    name: 'dotm-square-4',
    family: 'square',
    speed: 1.35,
    resolve: ({ index, row, col }, _s, { still }) => {
      if (row === 2 && col === 2) return null;
      const outerOrder = outerRingClockwiseOrderValue(index);
      if (outerOrder >= 0) {
        return still ? 0.2 + outerRingClockwiseNormFromIndex(index) * 0.72 : css(CSS.outerSnake, outerOrder * 0.0625);
      }
      return still
        ? 0.2 + middleRingAntiClockwiseNormFromIndex(index) * 0.72
        : css(CSS.middleSnake, middleRingAntiClockwiseOrderValue(index) * 0.125);
    },
  }),
  variant({
    name: 'dotm-square-5',
    family: 'square',
    speed: 1.35,
    resolve: ({ index }, _s, { still }) =>
      still
        ? 0.16 + diagonalSnakeNormFromIndex(index) * 0.78
        : css(CSS.diagonalSnake, diagonalSnakeOrderValue(index) * 0.04),
  }),
  variant({
    name: 'dotm-square-6',
    family: 'square',
    speed: 2.2,
    resolve: ({ row, col }, _s, { still }) => {
      const position = col % 2 === 0 ? 4 - row : row;
      return still ? 0.22 + (position / 4) * 0.66 : css(CSS.square6ColSnake, position * 0.2);
    },
  }),
  squareStepped('dotm-square-7', 1.35, 1900, SQUARE7_SEQUENCE.length, 10, ({ row, col }, step) =>
    maskOpacity(SQUARE7_MASKS[SQUARE7_SEQUENCE[step] ?? 0]!, row, col, { x: 1, o: 0.42, c: 0.88, '.': 0.08 }),
  ),
  squareStepped('dotm-square-8', 1.4, 2000, SQUARE8_SEQUENCE_LEN, 0, ({ row, col }, step, still) => {
    if (still) return 0.08;
    let height: number;
    let blink: number | null = null;
    if (step <= SQUARE8_FILL_LAST) {
      height = Math.max(0, Math.min(5, step - col));
    } else if (step < SQUARE8_FILL_LAST + 1 + 4) {
      height = 5;
      blink = SQUARE8_BLINK[step - (SQUARE8_FILL_LAST + 1)] ?? 1;
    } else {
      const drainTick = step - (SQUARE8_FILL_LAST + 1 + 4);
      height = Math.max(0, Math.min(5, 5 - Math.max(0, drainTick - col)));
    }
    const topLitRow = 5 - height;
    if (!(height > 0 && row >= topLitRow && row <= 4)) return 0.08;
    if (blink !== null) return blink;
    return row === topLitRow && height < 5 ? 1 : 0.52;
  }),
  variant({
    name: 'dotm-square-9',
    family: 'square',
    speed: 1.5,
    resolve: ({ row, col }, _s, { still }) => {
      const bit = brailleBit(row, col);
      const gap = row >= 1 && row <= 3 && col === 2;
      if (still) {
        if (bit !== null) return (CHECK_A & bit) !== 0 ? 0.26 : 0.08;
        return gap ? 0.12 : 0.08;
      }
      if (gap) return 0.12;
      if (bit === null) return 0.08;
      const lane = [D1, D2, D3, D4, D5, D6].indexOf(bit);
      return css(CSS.square9[lane]!);
    },
  }),
  squareStepped('dotm-square-10', 2.5, 1500, 5, 0, ({ row, col }, scanRow, still) => {
    if (still) return 0.08 + ((4 - row) / 4) * 0.38;
    const colGain = 1 + 0.07 * Math.sin(col * 1.72 + scanRow * 0.61);
    if (row > scanRow) return 0.08;
    const trail = Math.exp(-(scanRow - row) * 0.72);
    return Math.min(1, 0.08 + (1 - 0.08) * trail * colGain);
  }),
  variant({
    name: 'dotm-square-11',
    family: 'square',
    speed: 1.25,
    resolve: ({ manhattanDistance }, _s, { still }) => {
      const ring = Math.max(0, Math.min(4, manhattanDistance));
      return still ? 0.2 + (1 - ring / 4) * 0.72 : css(CSS.rippleEcho, ring * 0.14 + (ring % 2) * 0.03);
    },
  }),
  variant({
    name: 'dotm-square-12',
    family: 'square',
    speed: 1.35,
    resolve: ({ row, col }, _s, { still }) => {
      const ring = Math.max(0, Math.min(6, Math.abs(row - 1) + Math.abs(col - 1)));
      return still ? 0.2 + (1 - ring / 6) * 0.75 : css(CSS.centerOriginRipple, ring * 0.16);
    },
  }),
  squareStepped('dotm-square-13', 1.85, 1550, SQUARE13_SEQUENCE.length, 0, ({ row, col }, step) =>
    maskOpacity(SQUARE13_MASKS[SQUARE13_SEQUENCE[step] ?? 0]!, row, col, { x: 1, o: 0.56, '.': 0.08 }),
  ),
  square14,
  squareCycle('dotm-square-15', 1.25, 1600, ({ row, col }, phase, still) => {
    const rowPhase = (still ? 0 : phase) * 2 * 2 * Math.PI + row * 1.24;
    return helixOpacity(col, Math.round(1 + Math.sin(rowPhase)), rowPhase);
  }),
  squareCycle('dotm-square-16', 2.5, 1400, ({ row, col }, phase, still) => {
    const t = still ? 0 : phase * 20;
    const rowPhase = t * ((Math.PI * 2) / 19) + row * 1.24;
    return helixOpacity(col, Math.round(1.5 + 0.5 * Math.sin(rowPhase)), rowPhase);
  }),
  squareCycle('dotm-square-17', 2.5, 1600, ({ row, col }, phase, still) => {
    const t = still ? 0 : phase * 20;
    const strandCol = Math.round(2 + 2 * Math.sin(t * ((Math.PI * 2) / 19) + row * 1.24));
    if (col === strandCol) return 1;
    if (Math.abs(col - strandCol) === 1) return 0.24;
    return 0.08;
  }),
  squareCycle('dotm-square-18', 1.35, 1750, ({ row, col }, phase, still) => {
    const t = still ? 0 : phase * 24;
    const level = Math.max(1, Math.min(5, Math.round(1 + ((Math.sin(t * 0.52 + col * 1.15) + 1) / 2) * 4)));
    const topLitRow = 5 - level;
    if (row > topLitRow) return 0.94;
    if (row === topLitRow) return 1;
    return 0.08;
  }),
  squareStepped('dotm-square-19', 1.45, 1700, 48, 0, ({ row, col }, step, still) => {
    const dot = { x: (col - 2) / 2, y: (2 - row) / 2 };
    if (still) {
      let min = Number.POSITIVE_INFINITY;
      for (const sample of SQUARE19_CURVE) min = Math.min(min, squaredDistance(dot, sample));
      const curveGlow = Math.exp(-min / 0.2);
      const centerBoost = Math.exp(-(dot.x * dot.x + dot.y * dot.y) / 0.06);
      return Math.min(1, 0.08 + curveGlow * 0.2 + centerBoost * 0.18);
    }
    const influence = (head: { x: number; y: number }) => Math.exp(-squaredDistance(dot, head) / 0.19);
    const lead = Math.max(influence(square19LoopPoint(step)), influence(square19LoopPoint(step + 24)));
    const trail = Math.max(influence(square19LoopPoint(step - 4)), influence(square19LoopPoint(step + 24 - 4)));
    const centerPulse = Math.exp(-(dot.x * dot.x + dot.y * dot.y) / 0.05) * (0.45 + 0.55 * lead);
    return Math.min(1, 0.08 + 0.32 * trail + 0.62 * lead + 0.16 * centerPulse);
  }),
  squareStepped('dotm-square-20', 1.45, 1600, 16, 0, ({ index }, headStep, still) => {
    const onLoop = SQUARE20_PERIMETER.indexOf(index);
    if (still) {
      if (onLoop >= 0) return 0.48;
      return index === rowMajorIndex(2, 2) ? 0.22 : 0.08;
    }
    let opacity = 0.08;
    if (onLoop >= 0) {
      const backHead = (headStep + 8) % 16;
      opacity = Math.max(
        opacity,
        tailOpacity((headStep - onLoop + 16) % 16, SQUARE20_TAIL),
        tailOpacity((backHead - onLoop + 16) % 16, SQUARE20_BACK_TAIL),
      );
    }
    if (SQUARE20_TWIST.get(headStep) === index) opacity = Math.max(opacity, 0.52);
    if (index === rowMajorIndex(2, 2) && headStep % 4 === 0) opacity = Math.max(opacity, 0.55);
    return Math.min(1, opacity);
  }),
];

// ─── Catalog, hash, layout ───────────────────────────────────────────────────

export const DOT_MATRIX_CATALOG: readonly DotMatrixVariant[] = [...DOTM_3X3, ...DOTM_CIRCULAR, ...DOTM_SQUARE];

/** Web `SESSION_DOT_MATRIX_FAMILIES` is all three families, so the pool is the catalog. */
export const SESSION_DOT_MATRIX_POOL: readonly DotMatrixVariant[] = DOT_MATRIX_CATALOG;

/** FNV-1a over the session id, reduced onto the pool (web `sessionDotMatrixIndex`). */
export function sessionDotMatrixIndex(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SESSION_DOT_MATRIX_POOL.length;
}

/** The session's glyph; no session id → `dotm-square-14`, web's session-less default. */
export function sessionDotMatrixVariant(sessionId: string | undefined): DotMatrixVariant {
  if (!sessionId) return square14;
  return SESSION_DOT_MATRIX_POOL[sessionDotMatrixIndex(sessionId)]!;
}

export interface DotMatrixLayout {
  grid: GridSize;
  /** Width and height of the matrix box. */
  span: number;
  dotSize: number;
  gap: number;
  /** One grid track (`minmax(0, 1fr)`); a dot sits at its start. */
  track: number;
}

/**
 * Web box geometry. 5×5: `dotSize = round(size × 5 / 36)` (web
 * `fiveByFiveDotSizeFor`), `gap = max(1, floor((size − 5·dot) / 4))`, box = size.
 * 3×3: `DotMatrix3Base` defaults — 3px dots, `cellPadding` 1, box = 3·3 + 2·1.
 */
export function dotMatrixLayout(entry: DotMatrixVariant, size: number): DotMatrixLayout {
  if (entry.grid === 3) return { grid: 3, span: 11, dotSize: 3, gap: 1, track: 3 };
  const dotSize = Math.max(1, Math.round((size * 5) / 36));
  const gap = Math.max(1, Math.floor((size - dotSize * 5) / 4));
  return { grid: 5, span: size, dotSize, gap, track: (size - gap * 4) / 5 };
}
