"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular7Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const GATE_OPACITY = 0.92;

export function DotmCircular7({
  speed = 1.8,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular7Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const phase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1600,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase: p }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const x = col - 2;
      const y = row - 2;
      const t = reducedMotion || p === "idle" ? 0 : (phase) * Math.PI * 2;
      const ring = Math.sqrt(x * x + y * y);
      const angle = Math.atan2(y, x);

      const petalWave = 0.5 + 0.5 * Math.cos(5 * angle - t * 1.7);
      const ringWave = 0.5 + 0.5 * Math.cos(ring * 3.3 - t * 1.2);
      const chordWave = 0.5 + 0.5 * Math.cos((x + y) * 1.6 + t * 1.35);

      // Sharpen contrast so lit cells form clear, visible groups.
      const petalGate = Math.pow(petalWave, 2.2);
      const blend = 0.68 * petalGate + 0.22 * ringWave + 0.1 * chordWave;
      const opacity = BASE_OPACITY + (GATE_OPACITY - BASE_OPACITY) * blend;

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
