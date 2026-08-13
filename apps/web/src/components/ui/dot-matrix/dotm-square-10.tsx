"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { MATRIX_SIZE } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare10Props = DotMatrixCommonProps;

const ROWS = MATRIX_SIZE;

const BASE_OPACITY = 0.08;
const PEAK_OPACITY = 1;
const DECAY = 0.72;
const COL_WARP = 0.07;

export function DotmSquare10({
  speed = 2.5,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare10Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const scanRow = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1500,
    steps: ROWS,
    speed,
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      if (reducedMotion || phase === "idle") {
        const falloff = (ROWS - 1 - row) / Math.max(1, ROWS - 1);
        return { style: { opacity: BASE_OPACITY + falloff * 0.38 } };
      }

      const colGain = 1 + COL_WARP * Math.sin(col * 1.72 + scanRow * 0.61);

      if (row > scanRow) {
        return { style: { opacity: BASE_OPACITY } };
      }

      const age = scanRow - row;
      const trail = Math.exp(-age * DECAY);
      const opacity = BASE_OPACITY + (PEAK_OPACITY - BASE_OPACITY) * trail * colGain;

      return { style: { opacity: Math.min(PEAK_OPACITY, opacity) } };
    };
  }, [reducedMotion, scanRow]);

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
