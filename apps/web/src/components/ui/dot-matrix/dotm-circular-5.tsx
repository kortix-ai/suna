"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular5Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const BLADE_OPACITY = 0.94;
const HALO_OPACITY = 0.34;

export function DotmCircular5({
  speed = 1.7,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular5Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const phase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1650,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase: p }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const x = col - 2;
      const y = row - 2;
      const radius = Math.hypot(x, y);
      const angle = Math.atan2(y, x);
      const theta = (reducedMotion || p === "idle" ? 0 : phase) * Math.PI * 2;
      const pinwheel = Math.cos(angle * 4 - theta * 2.2);
      const radialGate = Math.sin(radius * 2.1 - theta * 1.25);

      if (radius < 0.6) {
        return { style: { opacity: 0.66 } };
      }

      if (pinwheel > 0.48 && radialGate > -0.25) {
        return { style: { opacity: BLADE_OPACITY } };
      }

      if (pinwheel > 0.1) {
        return { style: { opacity: HALO_OPACITY } };
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
