"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular20Props = DotMatrixCommonProps;

const STEP_COUNT = 30;
const BASE_OPACITY = 0.07;
const MID_OPACITY = 0.34;
const HIGH_OPACITY = 0.95;

const GLYPHS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["1,1", "2,1", "3,1", "1,3", "2,3", "3,3"]),
  new Set(["1,1", "2,1", "3,1", "2,2", "1,3", "3,3"]),
  new Set(["1,1", "1,2", "1,3", "3,1", "3,2", "3,3"]),
  new Set(["1,1", "2,1", "3,1", "1,3", "2,2", "3,3"]),
  new Set(["1,1", "2,2", "3,3", "1,3", "3,1"]),
  new Set(["2,1", "1,2", "2,2", "3,2", "2,3"])
];

export function DotmCircular20({
  speed = 1.5,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular20Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const animPhase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1500,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const t =
        reducedMotion || phase === "idle"
          ? 0
          : Math.floor((animPhase) * GLYPHS.length) % GLYPHS.length;
      const active = GLYPHS[t]!;
      const previous = GLYPHS[(t + GLYPHS.length - 1) % GLYPHS.length]!;
      const key = `${row},${col}`;

      let opacity = BASE_OPACITY;
      if (active.has(key)) {
        opacity = HIGH_OPACITY;
      } else if (previous.has(key)) {
        opacity = MID_OPACITY;
      } else if (row === 2 && col === 2) {
        opacity = 0.2;
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
