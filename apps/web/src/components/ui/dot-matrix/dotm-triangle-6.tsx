"use client";

import type { CSSProperties } from "react";

import { cx } from "@/lib/dotmatrix-core";
import { resolveDmxColorTokens } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { styleOpacity, stylePx } from "@/lib/dotmatrix-core";
import { remapOpacityToTriplet } from "@/lib/dotmatrix-core";
import { dmxBloomRootActive, dmxDotBloomParts } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";
import { applyDotMatrixScale } from "@/lib/dotmatrix-core";

export type DotmTriangle6Props = DotMatrixCommonProps;

const MATRIX_SIZE = 7;

/** Unicode / ISO braille dot numbering (same as `DotmSquare9`). */
const D1 = 0x01;
const D2 = 0x02;
const D3 = 0x04;
const D4 = 0x08;
const D5 = 0x10;
const D6 = 0x20;

const LOW_OPACITY = 0.07;
const MID_OPACITY = 0.36;
const HIGH_OPACITY = 0.96;

/** Half-width of the traveling ramp (larger = softer, more “gradient” overlap). */
const WAVE_HALF = 0.82;

/** Phase splits (must sum to 1): smooth intro wave, blink, fade reset. */
const INTRO_PHASE = 0.52;
const BLINK_PHASE = 0.36;
const RESET_PHASE = 0.12;

const TRIANGLE_CELLS = new Set([
  "1,3",
  "2,2",
  "2,4",
  "3,1",
  "3,3",
  "3,5",
  "4,0",
  "4,2",
  "4,4",
  "4,6"
]);

function smoothstep01(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) {
    return x >= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Six fills (D1..D6 order) from a single traveling wave front. */
function waveFills(introT: number): number[] {
  const waveCenter = -WAVE_HALF + introT * (5 + 2 * WAVE_HALF);
  return [0, 1, 2, 3, 4, 5].map((i) =>
    smoothstep01(i - WAVE_HALF, i + WAVE_HALF, waveCenter)
  );
}

function isWithinTriangleMask(row: number, col: number): boolean {
  if (row < 0 || row >= MATRIX_SIZE || col < 0 || col >= MATRIX_SIZE) {
    return false;
  }

  return TRIANGLE_CELLS.has(`${row},${col}`);
}

/** Map triangle cell → braille bit (ISO 2×3), or null for accent cells. */
function brailleBitForTriangle(row: number, col: number): number | null {
  if (row === 2 && col === 2) {
    return D1;
  }
  if (row === 3 && col === 1) {
    return D2;
  }
  if (row === 4 && col === 0) {
    return D3;
  }
  if (row === 2 && col === 4) {
    return D4;
  }
  if (row === 3 && col === 5) {
    return D5;
  }
  if (row === 4 && col === 6) {
    return D6;
  }
  return null;
}

const BIT_TO_FILL_INDEX: Record<number, number> = {
  [D1]: 0,
  [D2]: 1,
  [D3]: 2,
  [D4]: 3,
  [D5]: 4,
  [D6]: 5
};

function meanFills(indices: readonly number[], fills: readonly number[]): number {
  let s = 0;
  for (const i of indices) {
    s += fills[i] ?? 0;
  }
  return s / indices.length;
}

function opacityForCell(
  row: number,
  col: number,
  fills: readonly number[],
  blinkMul: number,
  resetMul: number
): number {
  const lift = (base: number) =>
    LOW_OPACITY + (base - LOW_OPACITY) * blinkMul * resetMul;

  const bit = brailleBitForTriangle(row, col);
  if (bit !== null) {
    const idx = BIT_TO_FILL_INDEX[bit] ?? 0;
    const raw = LOW_OPACITY + (HIGH_OPACITY - LOW_OPACITY) * (fills[idx] ?? 0);
    return lift(raw);
  }

  if (row === 1 && col === 3) {
    const m = meanFills([0, 3], fills);
    const raw = LOW_OPACITY + (HIGH_OPACITY - LOW_OPACITY) * m * 0.92 + (MID_OPACITY - LOW_OPACITY) * (1 - m) * 0.35;
    return lift(Math.min(HIGH_OPACITY, raw));
  }

  if (row === 3 && col === 3) {
    const m = meanFills([0, 1, 2, 3, 4, 5], fills);
    const raw =
      LOW_OPACITY +
      (HIGH_OPACITY - LOW_OPACITY) * m * 0.88 +
      (MID_OPACITY - LOW_OPACITY) * (1 - m) * 0.4;
    return lift(Math.min(HIGH_OPACITY, raw));
  }

  if (row === 4 && col === 2) {
    const m = meanFills([1, 2], fills);
    const raw = LOW_OPACITY + (MID_OPACITY + 0.28 - LOW_OPACITY) * m;
    return lift(raw);
  }
  if (row === 4 && col === 4) {
    const m = meanFills([4, 5], fills);
    const raw = LOW_OPACITY + (MID_OPACITY + 0.28 - LOW_OPACITY) * m;
    return lift(raw);
  }

  return LOW_OPACITY;
}

function cycleParams(phase: number): {
  fills: number[];
  blinkMul: number;
  resetMul: number;
} {
  if (phase < INTRO_PHASE) {
    const introT = phase / INTRO_PHASE;
    return { fills: waveFills(introT), blinkMul: 1, resetMul: 1 };
  }

  if (phase < INTRO_PHASE + BLINK_PHASE) {
    const bt = (phase - INTRO_PHASE) / BLINK_PHASE;
    const on = Math.floor(bt * 4) % 2 === 0;
    return { fills: [1, 1, 1, 1, 1, 1], blinkMul: on ? 1 : 0.08, resetMul: 1 };
  }

  const rt = (phase - INTRO_PHASE - BLINK_PHASE) / RESET_PHASE;
  const resetMul = 1 - smoothstep01(0, 1, rt);
  return { fills: [1, 1, 1, 1, 1, 1], blinkMul: 1, resetMul };
}

export function DotmTriangle6({
  scale = 1,
  size: sizeProp = 30,
  dotSize: dotSizeProp = 6.5,
  color = "currentColor",
  colorPreset,
  ariaLabel = "Loading",
  className,
  muted = false,
  bloom = false,
  halo = 0,
  dotClassName,
  dotShape = "circle",
  speed = 2.2,
  animated = true,
  hoverAnimated = false,
  cellPadding,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmTriangle6Props) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scale);
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const cycleActive = !reducedMotion && matrixPhase !== "idle";
  const cyclePhase = useCyclePhase({
    active: cycleActive,
    cycleMsBase: 3000,
    speed
  });

  const { fills, blinkMul, resetMul } = reducedMotion || matrixPhase === "idle"
    ? {
      fills: [0.55, 0.55, 0.55, 0.55, 0.55, 0.55] as number[],
      blinkMul: 1,
      resetMul: 1
    }
    : cycleParams(cyclePhase);

  const gap =
    cellPadding ?? Math.max(1, Math.floor((size - dotSize * MATRIX_SIZE) / (MATRIX_SIZE - 1)));
  const matrixSize = dotSize * MATRIX_SIZE + gap * (MATRIX_SIZE - 1);
  const { resolvedColor, dotFill } = resolveDmxColorTokens(color, colorPreset);
  const rootStyle = {
    width: stylePx(cellPadding == null ? size : matrixSize),
    height: stylePx(cellPadding == null ? size : matrixSize),
    ["--dmx-dot-size" as const]: `${dotSize}px`,
      ["--dmx-halo-level" as const]: halo,
    ["--dmx-dot-fill" as const]: dotFill,
    color: resolvedColor
  } as CSSProperties;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={cx("dmx-root", `dmx-dot-shape-${dotShape}`, muted && "dmx-muted", dmxBloomRootActive(bloom, halo) && "dmx-bloom", className)}
      style={rootStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        className="dmx-grid"
        style={{
          gap,
          gridTemplateColumns: `repeat(${MATRIX_SIZE}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${MATRIX_SIZE}, minmax(0, 1fr))`
        }}
      >
        {Array.from({ length: MATRIX_SIZE * MATRIX_SIZE }).map((_, index) => {
          const row = Math.floor(index / MATRIX_SIZE);
          const col = index % MATRIX_SIZE;
          const isActive = isWithinTriangleMask(row, col);

          const opacity = isActive ? opacityForCell(row, col, fills, blinkMul, resetMul) : 0;

                    const dmxBloom = dmxDotBloomParts(isActive, opacity, bloom, halo, opacityBase, opacityMid, opacityPeak);

          return (
            <span
              key={index}
              aria-hidden="true"
              className={cx("dmx-dot", !isActive && "dmx-inactive", dmxBloom.bloomDot && "dmx-bloom-dot", dotClassName)}
              style={{
                width: stylePx(dotSize),
                height: stylePx(dotSize),
                opacity: styleOpacity(remapOpacityToTriplet(opacity, opacityBase, opacityMid, opacityPeak)),
                ["--dmx-bloom-level" as const]: dmxBloom.level
              } as CSSProperties}
            />
          );
        })}
      </div>
    </div>
  );
}
