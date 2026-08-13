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

export type DotmTriangle11Props = DotMatrixCommonProps;

const MATRIX_SIZE = 7;

const BASE_OPACITY = 0.13;
const MID_OPACITY = 0.36;
const HIGH_OPACITY = 0.96;

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

const APEX_ROW = 1;
const APEX_COL = 3;

function isWithinTriangleMask(row: number, col: number): boolean {
  if (row < 0 || row >= MATRIX_SIZE || col < 0 || col >= MATRIX_SIZE) {
    return false;
  }

  return TRIANGLE_CELLS.has(`${row},${col}`);
}

function manhattanFromApex(row: number, col: number): number {
  return Math.abs(row - APEX_ROW) + Math.abs(col - APEX_COL);
}

function smoothstep01(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) {
    return x >= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Bright bands move down the triangle by tier: phase keys on Manhattan distance from the apex,
 * not the heart cell — reads as stacked horizontal “shelves” lighting in sequence.
 */
function opacityForCell(row: number, col: number, phase: number): number {
  const tier = manhattanFromApex(row, col);
  const maxTier = 6;
  const t = phase * Math.PI * 2;
  const u = (tier / maxTier) * Math.PI * 2 - t;
  const wave = 0.5 + 0.5 * Math.cos(u);
  const crest = smoothstep01(0.28, 0.98, wave);
  let opacity = BASE_OPACITY + crest * (HIGH_OPACITY - BASE_OPACITY);

  if (row === 3 && col === 3) {
    opacity = Math.max(opacity, MID_OPACITY + crest * 0.35);
  }

  return Math.min(HIGH_OPACITY, opacity);
}

export function DotmTriangle11({
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
  speed = 1.75,
  animated = true,
  hoverAnimated = false,
  cellPadding,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmTriangle11Props) {
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
    cycleMsBase: 1400,
    speed
  });

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

          const phase = reducedMotion || matrixPhase === "idle" ? 0.18 : cyclePhase;
          const opacity = isActive ? opacityForCell(row, col, phase) : 0;

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
