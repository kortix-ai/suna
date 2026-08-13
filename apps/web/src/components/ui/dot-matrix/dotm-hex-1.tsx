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

export type DotmHex1Props = DotMatrixCommonProps;

const ROW_COUNTS = [3, 4, 5, 4, 3] as const;
const BASE_OPACITY = 0.1;
const MID_OPACITY = 0.2;
const HIGH_OPACITY = 0.96;
const CENTER_OPACITY = 0.1;
const TRAIL_SPAN = 5;
const HEX_ROW_PITCH_RATIO = Math.sqrt(3) / 2;

function hexPatternIndex(row: number, rowCount: number, col: number): number {
  return row * ROW_COUNTS[2] + Math.floor((ROW_COUNTS[2] - rowCount) / 2) + col;
}

const PERIMETER_PATH = [
  "0,0",
  "0,1",
  "0,2",
  "1,3",
  "2,4",
  "3,3",
  "4,2",
  "4,1",
  "4,0",
  "3,0",
  "2,0",
  "1,0"
] as const;

const PATH_LEN = PERIMETER_PATH.length;
const HALF_PATH = PATH_LEN / 2;

function clamp01(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) {
    return;
  }
  return Math.min(1, Math.max(0, n));
}

function modF(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function smoothstep01(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) {
    return x >= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function glowAlongPath(head: number, pathIndex: number | null): number {
  if (pathIndex === null) {
    return BASE_OPACITY;
  }

  const distance = modF(head - pathIndex, PATH_LEN);
  const glow = 1 - smoothstep01(0, TRAIL_SPAN, distance);
  return BASE_OPACITY + glow * (HIGH_OPACITY - BASE_OPACITY);
}

function opacityForCell(id: string, phase: number): number {
  if (id === "2,2") {
    return CENTER_OPACITY;
  }

  const pathIndex = PERIMETER_PATH.indexOf(id as (typeof PERIMETER_PATH)[number]);
  const normalizedPathIndex = pathIndex === -1 ? null : pathIndex;
  const headA = phase * PATH_LEN;
  const headB = modF(headA + HALF_PATH, PATH_LEN);
  const perimeterGlow = Math.max(
    glowAlongPath(headA, normalizedPathIndex),
    glowAlongPath(headB, normalizedPathIndex) * 0.74
  );

  if (normalizedPathIndex !== null) {
    return Math.min(HIGH_OPACITY, perimeterGlow);
  }

  const [, col] = id.split(",").map(Number);
  const centerFalloff = col === 2 ? MID_OPACITY : 0.18;
  return Math.max(BASE_OPACITY, centerFalloff);
}

export function DotmHex1({
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
  speed = 1.6,
  animated = true,
  hoverAnimated = false,
  pattern = "full",
  cellPadding,
  boxSize,
  minSize,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmHex1Props) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scale);
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const cyclePhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1500,
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
  const phase = reducedMotion || matrixPhase === "idle" ? 0.08 : cyclePhase;
  const activePatternIndexes = getPatternIndexes(pattern);
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
          <div
            key={row}
            style={{
              display: "flex",
              justifyContent: "center",
              gap: stylePx(gap)
            }}
          >
            {Array.from({ length: count }).map((_, col) => {
              const id = `${row},${col}`;
              const isActive = activePatternIndexes.includes(hexPatternIndex(row, count, col));
              const opacity = isActive ? opacityForCell(id, phase) : 0;

                        const dmxBloom = dmxDotBloomParts(isActive, opacity, bloom, halo, ob, om, op);

          return (
                <span
                  key={id}
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
