"use client";

import type { CSSProperties } from "react";

import { cx } from "@/lib/dotmatrix-core";
import { resolveDmxColorTokens } from "@/lib/dotmatrix-core";
import { styleOpacity, stylePx } from "@/lib/dotmatrix-core";
import { remapOpacityToTriplet } from "@/lib/dotmatrix-core";
import { dmxBloomRootActive, dmxDotBloomParts } from "@/lib/dotmatrix-core";
import { getPatternIndexes } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";
import { applyDotMatrixScale } from "@/lib/dotmatrix-core";

export type DotmHex4Props = DotMatrixCommonProps;

const ROW_COUNTS = [3, 4, 5, 4, 3] as const;
const BASE_OPACITY = 0.08;
const MID_OPACITY = 0.36;
const HIGH_OPACITY = 0.98;
const HEX_ROW_PITCH_RATIO = Math.sqrt(3) / 2;

function hexPatternIndex(row: number, rowCount: number, col: number): number {
  return row * ROW_COUNTS[2] + Math.floor((ROW_COUNTS[2] - rowCount) / 2) + col;
}
const TRAIL_SPAN = 2.2;

const VERTEX_PATH = [
  "0,2",
  "1,3",
  "2,4",
  "3,3",
  "4,2",
  "3,0",
  "2,0",
  "1,0",
  "0,0"
] as const;

const ECHO_BY_VERTEX: Readonly<Record<(typeof VERTEX_PATH)[number], readonly string[]>> = {
  "0,2": ["0,1", "1,2"],
  "1,3": ["1,2", "2,3"],
  "2,4": ["2,3", "2,2"],
  "3,3": ["3,2", "2,3"],
  "4,2": ["4,1", "3,2"],
  "3,0": ["3,1", "2,1"],
  "2,0": ["2,1", "2,2"],
  "1,0": ["1,1", "2,1"],
  "0,0": ["0,1", "1,1"]
};

const PATH_LEN = VERTEX_PATH.length;

function clamp01(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) {
    return;
  }
  return Math.min(1, Math.max(0, n));
}

function pointForCell(row: number, col: number): { x: number; y: number } {
  const count = ROW_COUNTS[row] ?? 1;
  return {
    x: col - (count - 1) / 2,
    y: (row - 2) * HEX_ROW_PITCH_RATIO
  };
}

function modF(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function opacityForCell(row: number, col: number, phase: number): number {
  const id = `${row},${col}`;
  const head = phase * PATH_LEN;
  const vertexIndex = VERTEX_PATH.indexOf(id as (typeof VERTEX_PATH)[number]);
  let opacity = BASE_OPACITY;

  if (vertexIndex >= 0) {
    const distance = modF(head - vertexIndex, PATH_LEN);
    const glow = Math.max(0, 1 - distance / TRAIL_SPAN);
    opacity = Math.max(opacity, BASE_OPACITY + glow * (HIGH_OPACITY - BASE_OPACITY));
  }

  for (let i = 0; i < PATH_LEN; i += 1) {
    const vertex = VERTEX_PATH[i]!;
    if (!ECHO_BY_VERTEX[vertex].includes(id)) {
      continue;
    }

    const distance = modF(head - i, PATH_LEN);
    const echo = Math.max(0, 1 - Math.abs(distance - 0.55) / 1.45);
    opacity = Math.max(opacity, BASE_OPACITY + echo * 0.52);
  }

  if (id === "2,2") {
    const centerBeat = 0.5 + 0.5 * Math.sin(phase * Math.PI * PATH_LEN);
    opacity = Math.max(opacity, MID_OPACITY + centerBeat * 0.22);
  }

  const { x, y } = pointForCell(row, col);
  const softFill = Math.max(0, 1 - Math.sqrt(x * x + y * y) / 2.35) * 0.1;
  return Math.min(HIGH_OPACITY, opacity + softFill);
}

export function DotmHex4({
  scale = 1,
  size: sizeProp = 34,
  dotSize: dotSizeProp = 5,
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
  pattern = "full",
  cellPadding,
  boxSize,
  minSize,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmHex4Props) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scale);
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const cyclePhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1650,
    speed
  });

  const gap =
    cellPadding ?? Math.max(1, Math.floor((size - dotSize * ROW_COUNTS[2]) / (ROW_COUNTS[2] - 1)));
  const colPitch = dotSize + gap;
  const rowGap = Math.max(1, colPitch * HEX_ROW_PITCH_RATIO - dotSize);
  const matrixWidth = dotSize * ROW_COUNTS[2] + gap * (ROW_COUNTS[2] - 1);
  const matrixHeight = dotSize * ROW_COUNTS.length + rowGap * (ROW_COUNTS.length - 1);
  const matrixSpan = Math.max(matrixWidth, matrixHeight);
  const outerDim = Math.max(boxSize ?? matrixSpan, minSize ?? 0);
  const useWrapper = boxSize != null || minSize != null;
  const boxScale = useWrapper && matrixSpan > 0 ? outerDim / matrixSpan : 1;
  const ob = clamp01(opacityBase);
  const om = clamp01(opacityMid);
  const op = clamp01(opacityPeak);
  const phase = reducedMotion || matrixPhase === "idle" ? 0.12 : cyclePhase;
  const activePatternIndexes = new Set(getPatternIndexes(pattern));
  const { resolvedColor, dotFill } = resolveDmxColorTokens(color, colorPreset);
  const matrixStyle = {
    width: stylePx(matrixWidth),
    height: stylePx(matrixHeight),
    ["--dmx-dot-fill" as const]: dotFill,
    color: resolvedColor,
    ["--dmx-dot-size" as const]: `${dotSize}px`,
      ["--dmx-halo-level" as const]: halo,
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

  const matrix = (
    <div
      role={useWrapper ? undefined : "status"}
      aria-live={useWrapper ? undefined : "polite"}
      aria-label={useWrapper ? undefined : ariaLabel}
      className={cx("dmx-root", `dmx-dot-shape-${dotShape}`, muted && "dmx-muted", dmxBloomRootActive(bloom, halo) && "dmx-bloom", !useWrapper && className)}
      style={matrixStyle}
      onMouseEnter={useWrapper ? undefined : onMouseEnter}
      onMouseLeave={useWrapper ? undefined : onMouseLeave}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: stylePx(rowGap),
          width: "100%",
          height: "100%"
        }}
      >
        {ROW_COUNTS.map((count, row) => (
          <div key={row} style={{ display: "flex", justifyContent: "center", gap: stylePx(gap) }}>
            {Array.from({ length: count }).map((_, col) => {
              const isActive = activePatternIndexes.has(hexPatternIndex(row, count, col));
              const opacity = isActive ? opacityForCell(row, col, phase) : 0;

                        const dmxBloom = dmxDotBloomParts(isActive, opacity, bloom, halo, ob, om, op);

          return (
                <span
                  key={`${row},${col}`}
                  aria-hidden="true"
                  className={cx("dmx-dot", !isActive && "dmx-inactive", dmxBloom.bloomDot && "dmx-bloom-dot", dotClassName)}
                  style={{
                    width: stylePx(dotSize),
                    height: stylePx(dotSize),
                    opacity: styleOpacity(remapOpacityToTriplet(opacity, ob, om, op)),
                    ["--dmx-bloom-level" as const]: dmxBloom.level
                  } as CSSProperties}
                />
              );
            })}
          </div>
        ))}
      </div>
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
          width: stylePx(outerDim),
          height: stylePx(outerDim),
          minWidth: minSize == null ? undefined : stylePx(minSize),
          minHeight: minSize == null ? undefined : stylePx(minSize),
          overflow: "hidden"
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {matrix}
      </div>
    );
  }

  return matrix;
}
