"use client";

import { useMemo } from "react";

import { DotMatrix3Base } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { rowMajorIndex3 } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_11Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.06;
const PEAK_OPACITY = 0.88;
const CYCLE_MS_BASE = 2700;
const HOLD_RATIO = 0.52;
const MORPH_RATIO = 0.34;
const SMOOTH_TRANSITION = "opacity 120ms linear";

function smoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function patternWeight(pattern: ReadonlySet<number>, index: number): number {
  return pattern.has(index) ? 1 : 0;
}

/** Distinct 3×3 motifs that morph in sequence — corners, cross, full, center, ring, X, rails. */
const GLYPH_PATTERNS: readonly ReadonlySet<number>[] = [
  new Set([rowMajorIndex3(0, 0), rowMajorIndex3(0, 2), rowMajorIndex3(2, 0), rowMajorIndex3(2, 2)]),
  new Set([
    rowMajorIndex3(0, 1),
    rowMajorIndex3(1, 0),
    rowMajorIndex3(1, 1),
    rowMajorIndex3(1, 2),
    rowMajorIndex3(2, 1)
  ]),
  new Set(Array.from({ length: 9 }, (_, index) => index)),
  new Set([rowMajorIndex3(1, 1)]),
  new Set([
    rowMajorIndex3(0, 0),
    rowMajorIndex3(0, 1),
    rowMajorIndex3(0, 2),
    rowMajorIndex3(1, 0),
    rowMajorIndex3(1, 2),
    rowMajorIndex3(2, 0),
    rowMajorIndex3(2, 1),
    rowMajorIndex3(2, 2)
  ]),
  new Set([
    rowMajorIndex3(0, 0),
    rowMajorIndex3(0, 2),
    rowMajorIndex3(1, 1),
    rowMajorIndex3(2, 0),
    rowMajorIndex3(2, 2)
  ]),
  new Set([
    rowMajorIndex3(0, 1),
    rowMajorIndex3(1, 0),
    rowMajorIndex3(1, 2),
    rowMajorIndex3(2, 1)
  ])
];

function glyphMorphProgress(segmentPhase: number, stagger: number): number {
  const morphStart = HOLD_RATIO;
  const morphEnd = HOLD_RATIO + MORPH_RATIO;
  if (segmentPhase < morphStart + stagger * MORPH_RATIO) {
    return 0;
  }
  if (segmentPhase >= morphEnd) {
    return 1;
  }

  const localSpan = morphEnd - morphStart;
  const localPhase = (segmentPhase - morphStart - stagger * MORPH_RATIO) / (localSpan * (1 - stagger * 0.85));
  return smoothstep(localPhase);
}

export function Dotm3x3_11({
  speed = 1.25,
  pattern = "full",
  dotShape = "circle",
  animated = true,
  hoverAnimated = false,
  ...rest
}: Dotm3x3_11Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const cyclePhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: CYCLE_MS_BASE,
    speed
  });

  const animationResolver = useMemo<DotAnimationResolver>(() => {
    const patternCount = GLYPH_PATTERNS.length;
    const scaledPhase = cyclePhase * patternCount;
    const patternIndex = Math.floor(scaledPhase) % patternCount;
    const nextPatternIndex = (patternIndex + 1) % patternCount;
    const segmentPhase = scaledPhase - Math.floor(scaledPhase);
    const currentPattern = GLYPH_PATTERNS[patternIndex]!;
    const nextPattern = GLYPH_PATTERNS[nextPatternIndex]!;

    return ({ isActive, index, row, col, reducedMotion: rm, phase }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      const stagger = (row + col) / 4;
      const morphT = glyphMorphProgress(segmentPhase, stagger);
      let weight = patternWeight(currentPattern, index) * (1 - morphT)
        + patternWeight(nextPattern, index) * morphT;

      if (segmentPhase < HOLD_RATIO && weight > 0.01) {
        const breathe = 0.78 + 0.22 * Math.sin((segmentPhase / HOLD_RATIO) * Math.PI);
        weight *= breathe;
      }

      const opacity = BASE_OPACITY + weight * (PEAK_OPACITY - BASE_OPACITY);

      if (rm || phase === "idle") {
        return { style: { opacity } };
      }

      return { style: { opacity, transition: SMOOTH_TRANSITION } };
    };
  }, [cyclePhase]);

  return (
    <DotMatrix3Base
      {...rest}
      size={rest.size ?? 24}
      dotSize={rest.dotSize ?? 6}
      speed={speed}
      pattern={pattern}
      dotShape={dotShape}
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={animationResolver}
    />
  );
}
