"use client";

import type { CSSProperties } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { trBlPathNormFromIndex } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver } from "@/lib/dotmatrix-core";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare1Props = DotMatrixCommonProps;

const animationResolver: DotAnimationResolver = ({ isActive, index, row, col, reducedMotion, phase }) => {
  if (!isActive) {
    return { className: "dmx-inactive" };
  }

  const path = trBlPathNormFromIndex(index);
  const slice = row + (4 - col);
  const parity = slice % 2;
  const style = {
    "--dmx-path": path,
    "--dmx-diagonal-parity": parity
  } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return {
      style: {
        ...style,
        opacity: parity === 0 ? 0.88 : 0.14
      }
    };
  }

  return { className: "dmx-diagonal-alt-sweep", style };
};

export function DotmSquare1({
  speed = 1.1,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare1Props) {
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
