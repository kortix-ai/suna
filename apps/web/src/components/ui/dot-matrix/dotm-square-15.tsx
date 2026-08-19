"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare15Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const STRAND_OPACITY = 1;
const BRIDGE_OPACITY = 0.58;
const NEAR_STRAND_OPACITY = 0.24;
/** Integer full sin periods per matrix cycle so phase 0 ≡ phase 1 (no wrap glitch). */
const STRAND_LOOPS = 2;

export function DotmSquare15({
  speed = 1.25,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare15Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const animPhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1600,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      const u = reducedMotion || phase === "idle" ? 0 : animPhase;
      const rowPhase = u * STRAND_LOOPS * 2 * Math.PI + row * 1.24;
      const left = Math.round(1 + Math.sin(rowPhase));
      const right = 4 - left;
      const bridgeOn = Math.cos(rowPhase * 2) > 0.82;

      if (col === left || col === right) {
        return { style: { opacity: STRAND_OPACITY } };
      }

      if (bridgeOn && col > left && col < right) {
        return { style: { opacity: BRIDGE_OPACITY } };
      }

      if (Math.abs(col - left) === 1 || Math.abs(col - right) === 1) {
        return { style: { opacity: NEAR_STRAND_OPACITY } };
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
