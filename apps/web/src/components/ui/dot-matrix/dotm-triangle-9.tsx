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

export type DotmTriangle9Props = DotMatrixCommonProps;

const MATRIX_SIZE = 7;

const BASE_OPACITY = 0.14;
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

const DELTAS_8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
];

function buildBfsRingFromCenter(): Map<string, number> {
  const dist = new Map<string, number>();
  const start = "3,3";
  if (!TRIANGLE_CELLS.has(start)) {
    return dist;
  }

  const queue: [number, number][] = [[3, 3]];
  dist.set(start, 0);
  let head = 0;

  while (head < queue.length) {
    const [r, c] = queue[head]!;
    head += 1;
    const d = dist.get(`${r},${c}`)!;

    for (const [dr, dc] of DELTAS_8) {
      const nr = r + dr;
      const nc = c + dc;
      const key = `${nr},${nc}`;
      if (TRIANGLE_CELLS.has(key) && !dist.has(key)) {
        dist.set(key, d + 1);
        queue.push([nr, nc]);
      }
    }
  }

  return dist;
}

const BFS_RING = buildBfsRingFromCenter();
const MAX_RING = Math.max(0, ...BFS_RING.values());

function isWithinTriangleMask(row: number, col: number): boolean {
  if (row < 0 || row >= MATRIX_SIZE || col < 0 || col >= MATRIX_SIZE) {
    return false;
  }

  return TRIANGLE_CELLS.has(`${row},${col}`);
}

function smoothstep01(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) {
    return x >= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Concentric tiers from the heart (8-connected). One soft bright band travels outward/inward;
 * smoothstep softens the cosine so ring-to-ring steps do not read as harsh pops between discrete phase steps.
 */
function opacityForCell(row: number, col: number, phase: number): number {
  const ring = BFS_RING.get(`${row},${col}`) ?? 0;
  const span = Math.max(1, MAX_RING);
  const t = phase * Math.PI * 2;
  const u = (ring / span) * Math.PI * 2 - t;
  const wave = 0.5 + 0.5 * Math.cos(u);
  const crest = smoothstep01(0.35, 1, wave);
  const opacity = BASE_OPACITY + crest * (HIGH_OPACITY - BASE_OPACITY);
  return Math.min(HIGH_OPACITY, opacity);
}

export function DotmTriangle9({
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
  speed = 1.5,
  animated = true,
  hoverAnimated = false,
  cellPadding,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmTriangle9Props) {
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
    cycleMsBase: 1800,
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
