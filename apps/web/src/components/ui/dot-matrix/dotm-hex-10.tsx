"use client";

import type { CSSProperties } from "react";

import { cx } from "@/lib/dotmatrix-core";
import { resolveDmxColorTokens } from "@/lib/dotmatrix-core";
import { styleOpacity, stylePx } from "@/lib/dotmatrix-core";
import { remapOpacityToTriplet } from "@/lib/dotmatrix-core";
import { dmxBloomHaloSpreadClass, dmxBloomRootActive, dmxDotBloomParts } from "@/lib/dotmatrix-core";
import { getPatternIndexes } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";
import { applyDotMatrixScale } from "@/lib/dotmatrix-core";

export type DotmHex10Props = DotMatrixCommonProps;

const ROW_COUNTS = [3, 4, 5, 4, 3] as const;
const BASE_OPACITY = 0.09;
const HIGH_OPACITY = 0.98;
const HEX_ROW_PITCH_RATIO = Math.sqrt(3) / 2;

function hexPatternIndex(row: number, rowCount: number, col: number): number {
  return row * ROW_COUNTS[2] + Math.floor((ROW_COUNTS[2] - rowCount) / 2) + col;
}

function clamp01(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) {
    return;
  }
  return Math.min(1, Math.max(0, n));
}

function pointForCell(row: number, col: number): { x: number; y: number; angle: number; radius: number } {
  const count = ROW_COUNTS[row] ?? 1;
  const x = col - (count - 1) / 2;
  const y = (row - 2) * HEX_ROW_PITCH_RATIO;
  return {
    x,
    y,
    angle: Math.atan2(y, x),
    radius: Math.sqrt(x * x + y * y)
  };
}

function ripple(value: number, width: number): number {
  const wrapped = ((value % 1) + 1) % 1;
  const distance = Math.min(wrapped, 1 - wrapped);
  return Math.max(0, 1 - distance / width);
}

function opacityForCell(row: number, col: number, phase: number): number {
  const { x, y, radius } = pointForCell(row, col);
  const lensCenter = Math.sin(phase * Math.PI * 2) * 1.15;
  const lensDistance = Math.abs(lensCenter - x * 0.88 - y * 0.16);
  const liquidLens = Math.max(0, 1 - lensDistance / 0.78);

  const wakeFront = ripple(phase + x * 0.12 - y * 0.045 + radius * 0.07, 0.16);
  const wakeBack = ripple(phase + 0.34 + x * 0.09 + y * 0.035 + radius * 0.05, 0.2) * 0.34;
  const verticalCompression =
    Math.max(0, 1 - Math.abs(Math.cos(phase * Math.PI * 2) * 1.18 - y * 1.25) / 1.1) * 0.18;
  const shellSheen =
    (0.5 + 0.5 * Math.sin(phase * Math.PI * 2 - radius * 1.9)) * (radius > 1.35 ? 0.16 : 0.06);
  const core = radius < 0.1 ? 0.34 + Math.sin(phase * Math.PI * 2) * 0.1 : 0;

  return Math.min(
    HIGH_OPACITY,
    BASE_OPACITY + liquidLens * 0.72 + wakeFront * 0.38 + wakeBack + verticalCompression + shellSheen + core
  );
}

export function DotmHex10({
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
  speed = 1.55,
  animated = true,
  hoverAnimated = false,
  pattern = "full",
  cellPadding,
  boxSize,
  minSize,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmHex10Props) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scale);
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const cyclePhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1850,
    speed
  });

  const gap =
    cellPadding ?? Math.max(1, Math.floor((size - dotSize * ROW_COUNTS[2]) / (ROW_COUNTS[2] - 1)));
  const rowGap = Math.max(1, (dotSize + gap) * HEX_ROW_PITCH_RATIO - dotSize);
  const matrixWidth = dotSize * ROW_COUNTS[2] + gap * (ROW_COUNTS[2] - 1);
  const matrixHeight = dotSize * ROW_COUNTS.length + rowGap * (ROW_COUNTS.length - 1);
  const matrixSpan = Math.max(matrixWidth, matrixHeight);
  const outerDim = Math.max(boxSize ?? matrixSpan, minSize ?? 0);
  const useWrapper = boxSize != null || minSize != null;
  const boxScale = useWrapper && matrixSpan > 0 ? outerDim / matrixSpan : 1;
  const ob = clamp01(opacityBase);
  const om = clamp01(opacityMid);
  const op = clamp01(opacityPeak);
  const phase = reducedMotion || matrixPhase === "idle" ? 0.14 : cyclePhase;
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
      ? { transform: `scale(${boxScale})`, transformOrigin: "center center" as const }
      : { minWidth: minSize, minHeight: minSize })
  } as unknown as CSSProperties;

  const matrix = (
    <div role={useWrapper ? undefined : "status"} aria-live={useWrapper ? undefined : "polite"} aria-label={useWrapper ? undefined : ariaLabel} className={cx("dmx-root", `dmx-dot-shape-${dotShape}`, muted && "dmx-muted", dmxBloomRootActive(bloom, halo) && "dmx-bloom", dmxBloomHaloSpreadClass(halo), !useWrapper && className)} style={matrixStyle} onMouseEnter={useWrapper ? undefined : onMouseEnter} onMouseLeave={useWrapper ? undefined : onMouseLeave}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: stylePx(rowGap), width: "100%", height: "100%" }}>
        {ROW_COUNTS.map((count, row) => (
          <div key={row} style={{ display: "flex", justifyContent: "center", gap: stylePx(gap) }}>
            {Array.from({ length: count }).map((_, col) => {
              const isActive = activePatternIndexes.includes(hexPatternIndex(row, count, col));
              const opacity = isActive ? opacityForCell(row, col, phase) : 0;
              const dmxBloom = dmxDotBloomParts(isActive, opacity, bloom, halo, ob, om, op);
              return <span key={`${row},${col}`} aria-hidden="true" className={cx("dmx-dot", !isActive && "dmx-inactive", dmxBloom.bloomDot && "dmx-bloom-dot", dotClassName)} style={{ width: stylePx(dotSize), height: stylePx(dotSize), opacity: styleOpacity(remapOpacityToTriplet(opacity, ob, om, op)),
                    ["--dmx-bloom-level" as const]: dmxBloom.level } as CSSProperties} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );

  if (useWrapper) {
    return <div role="status" aria-live="polite" aria-label={ariaLabel} className={className} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: stylePx(outerDim), height: stylePx(outerDim), minWidth: minSize == null ? undefined : stylePx(minSize), minHeight: minSize == null ? undefined : stylePx(minSize), overflow: "hidden" }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>{matrix}</div>;
  }

  return matrix;
}
