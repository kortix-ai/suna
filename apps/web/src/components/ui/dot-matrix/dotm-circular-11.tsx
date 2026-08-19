"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { useCyclePhase } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular11Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.07;
const MID_OPACITY = 0.3;
const HIGH_OPACITY = 0.95;

export function DotmCircular11({
  speed = 1.65,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular11Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const phase = useCyclePhase({
    active: !reducedMotion && matrixPhase !== "idle",
    cycleMsBase: 1850,
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ row, col, phase: p }) => {
      if (!isWithinCircularMask(row, col)) {
        return { className: "dmx-inactive" };
      }

      const x = col - 2;
      const y = row - 2;
      const ring = Math.sqrt(x * x + y * y);
      const t = reducedMotion || p === "idle" ? 0 : (phase) * Math.PI * 2;
      const angle = Math.atan2(y, x);
      const moonCenterX = Math.cos(t) * 0.7;
      const moonCenterY = Math.sin(t) * 0.7;
      const body = Math.hypot(x - moonCenterX, y - moonCenterY);
      const cutCenterX = moonCenterX + Math.cos(t) * 0.82;
      const cutCenterY = moonCenterY + Math.sin(t) * 0.82;
      const cut = Math.hypot(x - cutCenterX, y - cutCenterY);
      const rim = Math.max(0, 1 - Math.abs(body - 1.55) / 0.35);
      const halo = Math.max(0, 1 - Math.acos(Math.cos(angle - t)) / 0.9);

      let opacity = BASE_OPACITY;
      if (body < 1.55 && cut > 1.05) {
        opacity = HIGH_OPACITY;
      } else if (rim > 0.5) {
        opacity = MID_OPACITY + rim * 0.22;
      } else if (halo > 0.68 && ring > 1.2) {
        opacity = MID_OPACITY;
      }

      return { style: { opacity: Math.min(HIGH_OPACITY, opacity) } };
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
