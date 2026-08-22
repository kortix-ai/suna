"use client";

import type { CSSProperties } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { rowMajorIndex } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular2Props = DotMatrixCommonProps;

const RING_PATH: readonly number[] = [
  rowMajorIndex(0, 1),
  rowMajorIndex(0, 2),
  rowMajorIndex(0, 3),
  rowMajorIndex(1, 4),
  rowMajorIndex(2, 4),
  rowMajorIndex(3, 4),
  rowMajorIndex(4, 3),
  rowMajorIndex(4, 2),
  rowMajorIndex(4, 1),
  rowMajorIndex(3, 0),
  rowMajorIndex(2, 0),
  rowMajorIndex(1, 0)
];

const LOOP_LEN = RING_PATH.length;
const BASE_OPACITY = 0.08;

export function DotmCircular2({
  speed = 1.8,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular2Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const resolver: DotAnimationResolver = ({ index, row, col, phase }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: "dmx-inactive" };
    }

    const onRing = RING_PATH.indexOf(index);
    if (onRing === -1) {
      return { style: { opacity: row === 2 && col === 2 ? 0.18 : BASE_OPACITY } };
    }

    if (reducedMotion || phase === "idle") {
      return { style: { opacity: 0.28 + (onRing / (LOOP_LEN - 1)) * 0.58 } };
    }

    return {
      className: "dmx-circular2-ring",
      style: { "--dmx-ring-order": onRing } as CSSProperties
    };
  };

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
