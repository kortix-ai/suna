"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular9Props = DotMatrixCommonProps;

const STEP_COUNT = 36;
const BASE_OPACITY = 0.07;
const MID_OPACITY = 0.28;
const STAR_OPACITY = 0.96;

export function DotmCircular9({
  speed = 5.55,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular9Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const step = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1900,
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
      const cardinalCenters = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
      const beaconIndex = Math.floor((step / STEP_COUNT) * cardinalCenters.length) % cardinalCenters.length;
      const activeCenter = cardinalCenters[beaconIndex]!;
      const oppositeCenter = cardinalCenters[(beaconIndex + 2) % cardinalCenters.length]!;

      const distanceToActive = Math.acos(Math.cos(angle - activeCenter));
      const distanceToOpposite = Math.acos(Math.cos(angle - oppositeCenter));
      const activeBeam = Math.max(0, 1 - distanceToActive / 0.5);
      const oppositeBeam = Math.max(0, 1 - distanceToOpposite / 0.65);
      const ringTier = Math.round(ring);

      let opacity = BASE_OPACITY;
      if (activeBeam > 0.8 && ringTier >= 2) {
        opacity = STAR_OPACITY;
      } else if (activeBeam > 0.45 && ringTier >= 1) {
        opacity = 0.62;
      } else if (oppositeBeam > 0.5 && ringTier >= 1) {
        opacity = MID_OPACITY;
      }

      if (x === 0 && y === 0) {
        return { style: { opacity: Math.max(opacity, 0.24) } };
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
