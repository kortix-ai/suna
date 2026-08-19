"use client";

import type { CSSProperties } from "react";

import { createDotm3x3Component } from "@/lib/dotmatrix-core";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_6Props = DotMatrixCommonProps;

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
  const style = { "--dmx-center-ripple-ring": ring } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return {
      style: {
        ...style,
        opacity: 0.06 + (1 - ring / 2) * 0.82
      }
    };
  }

  return { className: "dmx-center-ripple-3", style };
};

export const Dotm3x3_6 = createDotm3x3Component("Dotm3x3_6", animationResolver, 1.75);
