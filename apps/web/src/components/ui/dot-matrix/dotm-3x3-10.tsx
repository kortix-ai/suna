"use client";

import type { CSSProperties } from "react";

import { createDotm3x3Component } from "@/lib/dotmatrix-core";
import {
  isCenterCell3,
  outerRingClockwise3NormFromIndex,
  outerRingClockwise3OrderValue,
  wave3PathOpacityFromNorm
} from "@/lib/dotmatrix-core";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_10Props = DotMatrixCommonProps;

const animationResolver: DotAnimationResolver = ({
  isActive,
  index,
  row,
  col,
  reducedMotion,
  phase
}) => {
  if (!isActive) {
    return { className: "dmx-inactive" };
  }

  if (isCenterCell3(row, col)) {
    if (reducedMotion || phase === "idle") {
      return { style: { opacity: 0.2 } };
    }
    return { className: "dmx-core-pulse-3" };
  }

  const order = outerRingClockwise3OrderValue(index);
  const path = outerRingClockwise3NormFromIndex(index);
  const style = {
    "--dmx-frame-order": order,
    "--dmx-path": path
  } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return {
      style: {
        ...style,
        opacity: wave3PathOpacityFromNorm(path)
      }
    };
  }

  return { className: "dmx-frame-chase-3", style };
};

export const Dotm3x3_10 = createDotm3x3Component("Dotm3x3_10", animationResolver, 1.75);
