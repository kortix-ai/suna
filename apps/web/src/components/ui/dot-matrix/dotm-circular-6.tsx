"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular6Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const ORBIT_OPACITY = 0.96;
const NEAR_ORBIT_OPACITY = 0.34;

export function DotmCircular6({
  speed = 1.6,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular6Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const phase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1700,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase: p }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const x = col - 2;
      const y = row - 2;
      const t = reducedMotion || p === "idle" ? 0 : (phase) * Math.PI * 2;
      const angle = Math.atan2(y, x);
      const ring = Math.sqrt(x * x + y * y);

      const angularPhase = ((angle - t * 0.95 + Math.PI * 4) % (Math.PI * 2)) / ((Math.PI * 2) / 3);
      const sectorPos = angularPhase - Math.floor(angularPhase);
      const sectorPulse = Math.max(0, 1 - Math.abs(sectorPos - 0.5) * 2);
      const ringPhase = 0.5 + 0.5 * Math.cos(ring * 3.2 + t * 1.7);
      const score = 0.74 * sectorPulse + 0.26 * ringPhase;

      let opacity = BASE_OPACITY;
      if (score > 0.84) {
        opacity = ORBIT_OPACITY;
      } else if (score > 0.63) {
        opacity = 0.62;
      } else if (score > 0.44) {
        opacity = NEAR_ORBIT_OPACITY;
      }

      if (x === 0 && y === 0) {
        return { style: { opacity: Math.max(opacity, NEAR_ORBIT_OPACITY) } };
      }
      return { style: { opacity } };
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
