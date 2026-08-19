"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular16Props = DotMatrixCommonProps;

const STEP_COUNT = 25;
const BASE_OPACITY = 0.07;
const MID_OPACITY = 0.32;
const HIGH_OPACITY = 0.95;

export function DotmCircular16({
  speed = 1.1,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular16Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const animPhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1700,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      // Discrete steps: animPhase is continuous in [0, 1); fractional `t` breaks row === checks.
      const t =
        reducedMotion || phase === "idle" ? 0 : Math.floor(animPhase * STEP_COUNT) % STEP_COUNT;
      const activeRow = t % 5;
      const activeBrailleCol = Math.floor((t / 5) * 2) % 2; // left or right cell rail
      const railCol = activeBrailleCol === 0 ? 1 : 3;
      const nearCol = activeBrailleCol === 0 ? 2 : 2;
      const rowDistance = Math.abs(row - activeRow);

      let opacity = BASE_OPACITY;
      if (col === railCol && rowDistance === 0) {
        opacity = HIGH_OPACITY;
      } else if (col === railCol && rowDistance === 1) {
        opacity = MID_OPACITY;
      } else if (col === nearCol && rowDistance === 0) {
        opacity = 0.52;
      } else if ((col === 1 || col === 3) && rowDistance === 2) {
        opacity = 0.24;
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
