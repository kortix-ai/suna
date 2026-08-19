"use client";

import type { CSSProperties } from "react";

import { createDotm3x3Component } from "@/lib/dotmatrix-core";
import { colWave3NormFromColReverse, wave3PathOpacityFromNorm } from "@/lib/dotmatrix-core";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_13Props = DotMatrixCommonProps;

const animationResolver: DotAnimationResolver = ({ isActive, col, reducedMotion, phase }) => {
  if (!isActive) {
    return { className: "dmx-inactive" };
  }

  const path = colWave3NormFromColReverse(col);
  const style = { "--dmx-path": path } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return {
      style: {
        ...style,
        opacity: wave3PathOpacityFromNorm(path)
      }
    };
  }

  return { className: "dmx-path-3", style };
};

export const Dotm3x3_13 = createDotm3x3Component("Dotm3x3_13", animationResolver, 1.75);
