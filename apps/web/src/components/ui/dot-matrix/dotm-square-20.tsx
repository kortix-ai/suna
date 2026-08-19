"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { rowMajorIndex } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare20Props = DotMatrixCommonProps;

/** Clockwise perimeter: one closed loop you can trace with your eye. */
const PERIMETER_PATH: readonly number[] = [
  rowMajorIndex(0, 0),
  rowMajorIndex(0, 1),
  rowMajorIndex(0, 2),
  rowMajorIndex(0, 3),
  rowMajorIndex(0, 4),
  rowMajorIndex(1, 4),
  rowMajorIndex(2, 4),
  rowMajorIndex(3, 4),
  rowMajorIndex(4, 4),
  rowMajorIndex(4, 3),
  rowMajorIndex(4, 2),
  rowMajorIndex(4, 1),
  rowMajorIndex(4, 0),
  rowMajorIndex(3, 0),
  rowMajorIndex(2, 0),
  rowMajorIndex(1, 0)
];

const LOOP_LEN = PERIMETER_PATH.length;

const TAIL_BRIGHT = [1, 0.82, 0.64, 0.46, 0.3, 0.18] as const;
const BACK_TAIL_BRIGHT = [0.38, 0.3, 0.22, 0.14] as const;
const BASE_OPACITY = 0.08;
const TWIST_INNER_OPACITY = 0.52;
const SEAM_PULSE_OPACITY = 0.55;
const IDLE_RING_OPACITY = 0.48;

/** Corner steps on the loop → one cell “inside” the strip at the fold (half-twist cue). */
const TWIST_INNER_BY_HEAD_STEP: ReadonlyMap<number, number> = new Map([
  [0, rowMajorIndex(1, 1)],
  [4, rowMajorIndex(1, 3)],
  [8, rowMajorIndex(3, 3)],
  [12, rowMajorIndex(3, 1)]
]);

function pathStepForCellIndex(cellIndex: number): number {
  const step = PERIMETER_PATH.indexOf(cellIndex);
  return step;
}

function opacityFromTail(distance: number, tail: readonly number[]): number {
  if (distance < 0 || distance >= tail.length) {
    return 0;
  }
  return tail[distance]!;
}

export function DotmSquare20({
  speed = 1.45,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare20Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const headStep = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1600,
    steps: LOOP_LEN,
    speed,
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ isActive, index, phase }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      const onLoop = pathStepForCellIndex(index);
      const backHead = (headStep + Math.floor(LOOP_LEN / 2)) % LOOP_LEN;

      if (reducedMotion || phase === "idle") {
        if (onLoop >= 0) {
          return { style: { opacity: IDLE_RING_OPACITY } };
        }
        if (index === rowMajorIndex(2, 2)) {
          return { style: { opacity: 0.22 } };
        }
        return { style: { opacity: BASE_OPACITY } };
      }

      let opacity = BASE_OPACITY;

      if (onLoop >= 0) {
        const forward = (headStep - onLoop + LOOP_LEN) % LOOP_LEN;
        const alongBack = (backHead - onLoop + LOOP_LEN) % LOOP_LEN;
        opacity = Math.max(
          opacity,
          opacityFromTail(forward, TAIL_BRIGHT),
          opacityFromTail(alongBack, BACK_TAIL_BRIGHT)
        );
      }

      const twistInner = TWIST_INNER_BY_HEAD_STEP.get(headStep);
      if (twistInner === index) {
        opacity = Math.max(opacity, TWIST_INNER_OPACITY);
      }

      const seam = rowMajorIndex(2, 2);
      if (index === seam && headStep % 4 === 0) {
        opacity = Math.max(opacity, SEAM_PULSE_OPACITY);
      }

      return { style: { opacity: Math.min(1, opacity) } };
    };
  }, [headStep, reducedMotion]);

  return (
    <DotMatrixBase
      {...rest}
      size={rest.size ?? 36}
      dotSize={rest.dotSize ?? 5}
      speed={speed}
      pattern={pattern}
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={resolver}
    />
  );
}
