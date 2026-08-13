"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular8Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const PULSE_CORE = 0.95;
const PULSE_RING = 0.44;

export function DotmCircular8({
  speed = 1.95,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular8Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const phase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1400,
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
      const beat = reducedMotion || p === "idle" ? 0 : Math.sin((phase) * Math.PI * 2);
      const spike = reducedMotion || p === "idle" ? 0 : Math.sin((phase) * Math.PI * 4);
      const pulse = Math.max(0, beat) + Math.max(0, spike) * 0.55;

      if (radius < 0.55) {
        return { style: { opacity: Math.min(1, 0.35 + pulse * PULSE_CORE) } };
      }
      if (radius < 1.65) {
        return { style: { opacity: 0.16 + pulse * PULSE_RING } };
      }
      return { style: { opacity: BASE_OPACITY + pulse * 0.08 } };
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
