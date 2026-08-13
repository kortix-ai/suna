"use client";

import type { CSSProperties } from "react";

import { cx } from "@/lib/dotmatrix-core";
import { resolveDmxColorTokens } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { styleOpacity, stylePx } from "@/lib/dotmatrix-core";
import { remapOpacityToTriplet } from "@/lib/dotmatrix-core";
import { dmxBloomHaloSpreadClass, dmxBloomRootActive, dmxDotBloomParts } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";
import { applyDotMatrixScale } from "@/lib/dotmatrix-core";

export type DotmTriangle10Props = DotMatrixCommonProps;

const MATRIX_SIZE = 7;
const STEP_COUNT = 36;
const BASE_OPACITY = 0.07;
const TAIL_LEVELS = [0.94, 0.68, 0.42, 0.24] as const;

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

/** Bottom-to-top within each column, columns 0→6 — only triangle cells appear in the path. */
const COLUMN_RAKE_PATH: ReadonlyArray<readonly [number, number]> = [
  [4, 0],
  [3, 1],
  [4, 2],
  [2, 2],
  [3, 3],
  [1, 3],
  [4, 4],
  [2, 4],
  [4, 6],
  [3, 5]
];

function isWithinTriangleMask(row: number, col: number): boolean {
  if (row < 0 || row >= MATRIX_SIZE || col < 0 || col >= MATRIX_SIZE) {
    return false;
  }

  return TRIANGLE_CELLS.has(`${row},${col}`);
}

export function DotmTriangle10({
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
  speed = 1.8,
  animated = true,
  hoverAnimated = false,
  cellPadding,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmTriangle10Props) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scale);
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const step = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1750,
    steps: STEP_COUNT,
    speed,
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

  const pathLen = COLUMN_RAKE_PATH.length;
  const frame = reducedMotion || matrixPhase === "idle" ? 0 : step;
  const head = Math.floor((frame / STEP_COUNT) * pathLen) % pathLen;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={cx("dmx-root", `dmx-dot-shape-${dotShape}`, muted && "dmx-muted", dmxBloomRootActive(bloom, halo) && "dmx-bloom", dmxBloomHaloSpreadClass(halo), className)}
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

          let opacity = 0;
          if (isActive) {
            opacity = BASE_OPACITY;

            for (let trail = 0; trail < TAIL_LEVELS.length; trail += 1) {
              const idx = (head - trail + pathLen) % pathLen;
              const [pathRow, pathCol] = COLUMN_RAKE_PATH[idx]!;
              if (row === pathRow && col === pathCol) {
                opacity = Math.max(opacity, TAIL_LEVELS[trail]!);
                break;
              }
            }
          }

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
