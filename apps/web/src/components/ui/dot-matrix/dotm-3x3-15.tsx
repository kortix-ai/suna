"use client";

import type { CSSProperties } from "react";

import { createDotm3x3Component } from "@/lib/dotmatrix-core";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_15Props = DotMatrixCommonProps;

const animationResolver: DotAnimationResolver = ({
  isActive,
  manhattanDistance,
  reducedMotion,
  phase
}) => {
  if (!isActive) {
    return { className: "dmx-inactive" };
  }

  const ring = Math.max(0, Math.min(2, manhattanDistance));
  const style = {
    "--dmx-ripple-ring": ring,
    "--dmx-ripple-parity": ring % 2
  } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return {
      style: {
        ...style,
        opacity: 0.06 + (1 - ring / 2) * 0.82
      }
    };
  }

  return { className: "dmx-ripple-echo-3", style };
};

export const Dotm3x3_15 = createDotm3x3Component("Dotm3x3_15", animationResolver, 1.75);
