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

export type DotmTriangle8Props = DotMatrixCommonProps;

const MATRIX_SIZE = 7;

const BASE_OPACITY = 0.05;
const MID_OPACITY = 0.42;
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

const LEFT_WING = new Set(["2,2", "3,1", "4,0", "4,2"]);
const RIGHT_WING = new Set(["2,4", "3,5", "4,4", "4,6"]);

function isWithinTriangleMask(row: number, col: number): boolean {
  if (row < 0 || row >= MATRIX_SIZE || col < 0 || col >= MATRIX_SIZE) {
    return false;
  }

  return TRIANGLE_CELLS.has(`${row},${col}`);
}

type Sector = "left" | "right" | "spine" | "none";

function sectorForCell(row: number, col: number): Sector {
  const key = `${row},${col}`;
  if (row === 1 && col === 3) {
    return "spine";
  }
  if (row === 3 && col === 3) {
    return "spine";
  }
  if (LEFT_WING.has(key)) {
    return "left";
  }
  if (RIGHT_WING.has(key)) {
    return "right";
  }
  return "none";
}

/**
 * Alternating emphasis on the two lower wings (split by the apex column), with the apex and
 * heart dot brightest when energy crosses the middle (both sides briefly equal).
 */
function opacityForCell(row: number, col: number, phase: number): number {
  const p = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  const leftLift = p * p;
  const rightLift = (1 - p) * (1 - p);
  const crossover = Math.max(0, 1 - 4 * (p - 0.5) * (p - 0.5));

  const sector = sectorForCell(row, col);
  if (sector === "none") {
    return 0;
  }

  if (sector === "spine") {
    if (row === 1 && col === 3) {
      const apex = MID_OPACITY + crossover * (HIGH_OPACITY - MID_OPACITY) * 0.95;
      return Math.min(HIGH_OPACITY, apex);
    }
    const hub = BASE_OPACITY + crossover * 0.55 * (HIGH_OPACITY - BASE_OPACITY) + leftLift * 0.08 + rightLift * 0.08;
    return Math.min(HIGH_OPACITY, hub);
  }

  if (sector === "left") {
    const wing = BASE_OPACITY + leftLift * (HIGH_OPACITY - BASE_OPACITY);
    return Math.min(HIGH_OPACITY, wing);
  }

  const wing = BASE_OPACITY + rightLift * (HIGH_OPACITY - BASE_OPACITY);
  return Math.min(HIGH_OPACITY, wing);
}

export function DotmTriangle8({
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
  speed = 1.55,
  animated = true,
  hoverAnimated = false,
  cellPadding,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmTriangle8Props) {
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
    cycleMsBase: 1500,
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

          const phase = reducedMotion || matrixPhase === "idle" ? 0.25 : cyclePhase;
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
