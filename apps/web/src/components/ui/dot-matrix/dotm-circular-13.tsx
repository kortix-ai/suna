"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular13Props = DotMatrixCommonProps;

const STEP_COUNT = 28;
const BASE_OPACITY = 0.07;
const STRAND_OPACITY = 0.95;
const NEAR_STRAND_OPACITY = 0.5;
const BRIDGE_OPACITY = 0.3;

export function DotmCircular13({
  speed = 1.55,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular13Props) {
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

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const x = col - 2;
      const y = row - 2;
      const t = reducedMotion || phase === "idle" ? 0 : (step / STEP_COUNT) * Math.PI * 2;

      const strandOffset = Math.sin(y * 1.35 + t * 1.3) * 1.15;
      const leftStrand = -strandOffset;
      const rightStrand = strandOffset;
      const leftDistance = Math.abs(x - leftStrand);
      const rightDistance = Math.abs(x - rightStrand);
      const strandDistance = Math.min(leftDistance, rightDistance);
      const bridgeOn = Math.cos(y * 2 + t * 2.1) > 0.55;
      const isBetweenStrands = x > Math.min(leftStrand, rightStrand) && x < Math.max(leftStrand, rightStrand);

      let opacity = BASE_OPACITY;
      if (strandDistance < 0.34) {
        opacity = STRAND_OPACITY;
      } else if (strandDistance < 0.8) {
        opacity = NEAR_STRAND_OPACITY;
      } else if (bridgeOn && isBetweenStrands) {
        opacity = BRIDGE_OPACITY;
      }

      return { style: { opacity } };
    };
  }, [reducedMotion, step]);

  return (
    <DotMatrixBase
      {...rest}
      size={rest.size ?? 36}
      dotSize={rest.dotSize ?? 5}
      speed={speed}
      pattern="full"
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={resolver}
    />
  );
}
