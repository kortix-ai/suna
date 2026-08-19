"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular4Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const SWEEP_OPACITY = 0.96;
const NEAR_SWEEP_OPACITY = 0.36;
const RING_OPACITY = 0.22;

export function DotmCircular4({
  speed = 1.55,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular4Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const phase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1800,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase: p }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const centerRow = row - 2;
      const centerCol = col - 2;
      const radius = Math.hypot(centerRow, centerCol);
      const theta = (reducedMotion || p === "idle" ? 0 : phase) * Math.PI * 2;
      const sweepX = Math.cos(theta);
      const sweepY = Math.sin(theta);
      const projection = centerCol * sweepX + centerRow * sweepY;
      const perpendicular = Math.abs(centerCol * sweepY - centerRow * sweepX);

      if (radius < 0.5) {
        return { style: { opacity: 0.62 } };
      }

      if (projection > 0.3 && perpendicular < 0.55) {
        return { style: { opacity: SWEEP_OPACITY } };
      }

      if (projection > 0 && perpendicular < 1.15) {
        return { style: { opacity: NEAR_SWEEP_OPACITY } };
      }

      if (radius > 1.6 && radius < 2.3) {
        return { style: { opacity: RING_OPACITY } };
      }

      return { style: { opacity: BASE_OPACITY } };
    };
  }, [reducedMotion, phase]);

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
