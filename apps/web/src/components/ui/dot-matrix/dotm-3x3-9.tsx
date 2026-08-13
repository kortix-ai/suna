"use client";

import type { CSSProperties } from "react";

import { createDotm3x3Component } from "@/lib/dotmatrix-core";
import { snakePath3NormFromIndex, snakePath3OrderValue, wave3PathOpacityFromNorm } from "@/lib/dotmatrix-core";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_9Props = DotMatrixCommonProps;

const animationResolver: DotAnimationResolver = ({ isActive, index, reducedMotion, phase }) => {
  if (!isActive) {
    return { className: "dmx-inactive" };
  }

  const order = snakePath3OrderValue(index);
  const path = snakePath3NormFromIndex(index);
  const style = {
    "--dmx-snake-order": order,
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

  return { className: "dmx-snake-path-3", style };
};

export const Dotm3x3_9 = createDotm3x3Component("Dotm3x3_9", animationResolver, 1.75);
