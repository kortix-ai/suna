"use client";

import type { CSSProperties } from "react";

import { cx } from "@/lib/dotmatrix-core";
import { resolveDmxColorTokens } from "@/lib/dotmatrix-core";
import { styleOpacity, stylePx } from "@/lib/dotmatrix-core";
import { remapOpacityToTriplet } from "@/lib/dotmatrix-core";
import { dmxBloomHaloSpreadClass, dmxBloomRootActive, dmxDotBloomParts } from "@/lib/dotmatrix-core";
import { getPatternIndexes } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";
import { applyDotMatrixScale } from "@/lib/dotmatrix-core";

export type DotmHex8Props = DotMatrixCommonProps;

const ROW_COUNTS = [3, 4, 5, 4, 3] as const;
const BASE_OPACITY = 0.2;
const MID_OPACITY = 0.46;
const HIGH_OPACITY = 0.98;
const HEX_ROW_PITCH_RATIO = Math.sqrt(3) / 2;

function hexPatternIndex(row: number, rowCount: number, col: number): number {
  return row * ROW_COUNTS[2] + Math.floor((ROW_COUNTS[2] - rowCount) / 2) + col;
}
const FRAMES: readonly Readonly<Record<string, "x" | "o">>[] = [
  { "0,1": "x", "1,1": "o", "1,2": "o", "2,0": "x", "2,2": "x", "2,4": "x", "3,1": "o", "3,2": "o", "4,1": "x" },
  { "0,0": "x", "0,2": "x", "1,0": "o", "1,3": "o", "2,1": "x", "2,2": "o", "2,3": "x", "3,0": "o", "3,3": "o", "4,0": "x", "4,2": "x" },
  { "0,1": "o", "1,0": "x", "1,3": "x", "2,0": "o", "2,2": "x", "2,4": "o", "3,0": "x", "3,3": "x", "4,1": "o" },
  { "0,0": "o", "0,2": "o", "1,1": "x", "1,2": "x", "2,1": "o", "2,3": "o", "3,1": "x", "3,2": "x", "4,0": "o", "4,2": "o" }
];

function clamp01(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) return;
  return Math.min(1, Math.max(0, n));
}

export function DotmHex8({
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
  speed = 1.35,
  animated = true,
  hoverAnimated = false,
  pattern = "full",
  cellPadding,
  boxSize,
  minSize,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotmHex8Props) {
  const { size, dotSize } = applyDotMatrixScale(sizeProp, dotSizeProp, scale);
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({ animated: Boolean(animated && !reducedMotion), hoverAnimated: Boolean(hoverAnimated && !reducedMotion), speed });
  const step = useSteppedCycle({ active: !reducedMotion && matrixPhase !== "idle", cycleMsBase: 1400, steps: FRAMES.length, speed });
  const frame = FRAMES[reducedMotion || matrixPhase === "idle" ? 0 : step] ?? FRAMES[0]!;
  const gap = cellPadding ?? Math.max(1, Math.floor((size - dotSize * ROW_COUNTS[2]) / (ROW_COUNTS[2] - 1)));
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
  const activePatternIndexes = new Set(getPatternIndexes(pattern));
  const { resolvedColor, dotFill } = resolveDmxColorTokens(color, colorPreset);
  const matrixStyle = { width: stylePx(matrixWidth), height: stylePx(matrixHeight), ["--dmx-dot-fill" as const]: dotFill, color: resolvedColor, ["--dmx-dot-size" as const]: `${dotSize}px`,
      ["--dmx-halo-level" as const]: halo, ...(ob !== undefined && { ["--dmx-opacity-base" as const]: ob }), ...(om !== undefined && { ["--dmx-opacity-mid" as const]: om }), ...(op !== undefined && { ["--dmx-opacity-peak" as const]: op }), ...(useWrapper ? { transform: `scale(${boxScale})`, transformOrigin: "center center" as const } : { minWidth: minSize, minHeight: minSize }) } as unknown as CSSProperties;

  const matrix = (
    <div role={useWrapper ? undefined : "status"} aria-live={useWrapper ? undefined : "polite"} aria-label={useWrapper ? undefined : ariaLabel} className={cx("dmx-root", `dmx-dot-shape-${dotShape}`, muted && "dmx-muted", dmxBloomRootActive(bloom, halo) && "dmx-bloom", dmxBloomHaloSpreadClass(halo), !useWrapper && className)} style={matrixStyle} onMouseEnter={useWrapper ? undefined : onMouseEnter} onMouseLeave={useWrapper ? undefined : onMouseLeave}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: stylePx(rowGap), width: "100%", height: "100%" }}>
        {ROW_COUNTS.map((count, row) => (
          <div key={row} style={{ display: "flex", justifyContent: "center", gap: stylePx(gap) }}>
            {Array.from({ length: count }).map((_, col) => {
              const tone = frame[`${row},${col}`];
              const isActive = activePatternIndexes.has(hexPatternIndex(row, count, col));
              const opacity = isActive ? tone === "x" ? HIGH_OPACITY : tone === "o" ? MID_OPACITY : BASE_OPACITY : 0;
              const dmxBloom = dmxDotBloomParts(isActive, opacity, bloom, halo, ob, om, op);
              return <span key={`${row},${col}`} aria-hidden="true" className={cx("dmx-dot", !isActive && "dmx-inactive", dmxBloom.bloomDot && "dmx-bloom-dot", dotClassName)} style={{ width: stylePx(dotSize), height: stylePx(dotSize), opacity: styleOpacity(remapOpacityToTriplet(opacity, ob, om, op)),
                    ["--dmx-bloom-level" as const]: dmxBloom.level, transition: "opacity 160ms ease-out" } as CSSProperties} />;
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
