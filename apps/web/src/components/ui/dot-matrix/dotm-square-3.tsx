"use client";

import type { CSSProperties } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { spiralInwardNormFromIndex, spiralInwardOrderValue } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare3Props = DotMatrixCommonProps;

const animationResolver: DotAnimationResolver = ({ isActive, index, reducedMotion, phase }) => {
  if (!isActive) {
    return { className: "dmx-inactive" };
  }

  const order = spiralInwardOrderValue(index);
  const pathNorm = spiralInwardNormFromIndex(index);
  const style = { "--dmx-spiral-order": order } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return {
      style: {
        ...style,
        opacity: 0.16 + pathNorm * 0.78
      }
    };
  }

  return { className: "dmx-spiral-snake", style };
};

export function DotmSquare3({
  speed = 1.35,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare3Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });

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
      animationResolver={animationResolver}
    />
  );
}
