"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular10Props = DotMatrixCommonProps;

const STEP_COUNT = 30;
const BASE_OPACITY = 0.06;
const LOW_OPACITY = 0.2;
const MID_OPACITY = 0.48;
const HIGH_OPACITY = 0.94;

function moduloDistance(a: number, b: number, mod: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, mod - raw);
}

export function DotmCircular10({
  speed = 1.75,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular10Props) {
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
    return ({ row, col, phase }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const x = col - 2;
      const y = row - 2;
      const ring = Math.round(Math.sqrt(x * x + y * y));
      const tick = reducedMotion || phase === "idle" ? 0 : Math.floor((animPhase) * 10);
      const cellCode = (row * 3 + col * 5 + ring * 2) % 10;
      const d = moduloDistance(cellCode, tick, 10);
      const parityGate = (row + col + tick) % 2 === 0;

      let opacity = BASE_OPACITY;
      if (d === 0) {
        opacity = HIGH_OPACITY;
      } else if (d === 1) {
        opacity = MID_OPACITY;
      } else if (d === 2 || parityGate) {
        opacity = LOW_OPACITY;
      }

      if (x === 0 && y === 0) {
        return { style: { opacity: Math.max(opacity, MID_OPACITY) } };
      }

      return { style: { opacity } };
    };
  }, [reducedMotion, animPhase]);

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
