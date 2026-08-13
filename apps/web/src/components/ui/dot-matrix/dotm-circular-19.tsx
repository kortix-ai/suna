"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular19Props = DotMatrixCommonProps;

const STEP_COUNT = 24;
const BASE_OPACITY = 0.07;
const MID_OPACITY = 0.34;
const HIGH_OPACITY = 0.95;

const ORBIT_POINTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 3],
  [3, 3],
  [3, 2],
  [3, 1],
  [2, 1]
];

export function DotmCircular19({
  speed = 1.6,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular19Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const phase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1280,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase: p }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const t =
        reducedMotion || p === "idle"
          ? 0
          : Math.floor((phase) * ORBIT_POINTS.length) % ORBIT_POINTS.length;
      const [headRow, headCol] = ORBIT_POINTS[t]!;
      const [tailRow, tailCol] = ORBIT_POINTS[(t + ORBIT_POINTS.length - 1) % ORBIT_POINTS.length]!;

      let opacity = BASE_OPACITY;
      if (row === headRow && col === headCol) {
        opacity = HIGH_OPACITY;
      } else if (row === tailRow && col === tailCol) {
        opacity = 0.62;
      } else if ((col === 1 || col === 3) && (row === 1 || row === 2 || row === 3)) {
        opacity = MID_OPACITY;
      } else if (row === 2 && col === 2) {
        opacity = 0.2;
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
