"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare18Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const LIT_OPACITY = 0.94;
const CAP_OPACITY = 1;
const STEP_COUNT = 24;
const MAX_LEVEL = 5;

function clampLevel(value: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, Math.round(value)));
}

export function DotmSquare18({
  speed = 1.35,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare18Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const animPhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1750,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      const t = reducedMotion || phase === "idle" ? 0 : animPhase * STEP_COUNT;
      const colPhase = t * 0.52 + col * 1.15;
      const level = clampLevel(1 + ((Math.sin(colPhase) + 1) / 2) * (MAX_LEVEL - 1));
      const topLitRow = MAX_LEVEL - level;

      if (row > topLitRow) {
        return { style: { opacity: LIT_OPACITY } };
      }
      if (row === topLitRow) {
        return { style: { opacity: CAP_OPACITY } };
      }
      return { style: { opacity: BASE_OPACITY } };
    };
  }, [reducedMotion, animPhase]);

  return (
    <DotMatrixBase
      {...rest}
      size={rest.size ?? 36}
      dotSize={rest.dotSize ?? 5}
      speed={speed}
      pattern={pattern}
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={resolver}
    />
  );
}
