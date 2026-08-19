"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular14Props = DotMatrixCommonProps;

const STEP_COUNT = 30;
const BASE_OPACITY = 0.07;
const RUNG_OPACITY = 0.95;
const SIDE_OPACITY = 0.56;
const GHOST_OPACITY = 0.28;

export function DotmCircular14({
  speed = 1.75,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular14Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const animPhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1650,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const x = col - 2;
      const y = row - 2;
      const phaseStep = reducedMotion || phase === "idle" ? 0 : Math.floor((animPhase) * 10);
      const activeRow = (phaseStep + 5) % 5;
      const rowDistance = Math.abs(row - activeRow);
      const swing = Math.sin((phaseStep / 10) * Math.PI * 2 + y * 0.9);
      const leftAnchor = Math.round(1 + swing);
      const rightAnchor = 4 - leftAnchor;

      let opacity = BASE_OPACITY;
      if (row === activeRow && col >= leftAnchor && col <= rightAnchor) {
        opacity = RUNG_OPACITY;
      } else if ((col === leftAnchor || col === rightAnchor) && rowDistance <= 1) {
        opacity = SIDE_OPACITY;
      } else if ((col === leftAnchor || col === rightAnchor) && rowDistance === 2) {
        opacity = GHOST_OPACITY;
      }

      if (x === 0 && y === 0 && rowDistance <= 1) {
        return { style: { opacity: Math.max(opacity, SIDE_OPACITY) } };
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
