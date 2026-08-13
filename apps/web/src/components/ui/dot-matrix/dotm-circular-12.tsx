"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular12Props = DotMatrixCommonProps;

const STEP_COUNT = 36;
const BASE_OPACITY = 0.06;
const MID_OPACITY = 0.3;
const ARC_OPACITY = 0.96;

export function DotmCircular12({
  speed = 1.7,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular12Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const step = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1700,
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
      const ring = Math.sqrt(x * x + y * y);
      const angle = Math.atan2(y, x);
      const t = reducedMotion || phase === "idle" ? 0 : (step / STEP_COUNT) * Math.PI * 2;
      const stepBand = Math.floor((step / STEP_COUNT) * 8) % 8;
      const targetAngle = stepBand * (Math.PI / 4);
      const angleDelta = Math.acos(Math.cos(angle - targetAngle));
      const beam = Math.max(0, 1 - angleDelta / 0.42);
      const oppositeBeam = Math.max(0, 1 - Math.acos(Math.cos(angle - (targetAngle + Math.PI))) / 0.62);
      const spokePulse = Math.max(0, 1 - Math.abs(Math.abs(x) - Math.abs(y)) / 0.35);
      const ringTier = ring < 1 ? 0 : ring < 2 ? 1 : 2;

      let opacity = BASE_OPACITY;
      if (beam > 0.78 && ringTier >= 1) {
        opacity = ARC_OPACITY;
      } else if (beam > 0.48) {
        opacity = 0.62;
      } else if (oppositeBeam > 0.52 && ringTier === 2) {
        opacity = MID_OPACITY;
      } else if (spokePulse > 0.9 && ringTier > 0) {
        opacity = MID_OPACITY;
      }

      if (x === 0 && y === 0) {
        return { style: { opacity: Math.max(opacity, 0.26) } };
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
