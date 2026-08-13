"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { rowMajorIndex } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare14Props = DotMatrixCommonProps;

type FrameCell = "." | "o" | "x";

const BASE_OPACITY = 0.08;
const MID_OPACITY = 0.52;
const PEAK_OPACITY = 1;
const SMOOTH_TRANSITION = "opacity 180ms cubic-bezier(0.4, 0, 0.2, 1)";

const FRAME_MASKS: readonly string[] = [
  // Diagonal star
  "x...x" + ".x.x." + "..o.." + ".x.x." + "x...x",
  // Diamond bloom
  "..x.." + ".oxo." + "xooox" + ".oxo." + "..x..",
  // Petal ring
  ".x.x." + "x.o.x" + "..o.." + "x.o.x" + ".x.x.",
  // Crossed lattice
  "x.x.x" + ".o.o." + "x.o.x" + ".o.o." + "x.x.x"
];

const FRAME_SEQUENCE: readonly number[] = [0, 1, 2, 3, 2, 1];

function maskCell(mask: string, row: number, col: number): FrameCell {
  return (mask[rowMajorIndex(row, col)] as FrameCell | undefined) ?? ".";
}

export function DotmSquare14({
  speed = 1.25,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  size = 14,
  dotSize = 2,
  ...rest
}: DotmSquare14Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const sequenceLength = FRAME_SEQUENCE.length;
  const step = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle" && sequenceLength > 0,
    cycleMsBase: 1700,
    steps: sequenceLength,
    speed,
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    const frameIndex = FRAME_SEQUENCE[step] ?? 0;
    const mask = FRAME_MASKS[frameIndex] ?? FRAME_MASKS[0]!;

    return ({ isActive, row, col }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      const cell = maskCell(mask, row, col);
      if (cell === "x") {
        return { style: { opacity: PEAK_OPACITY, transition: SMOOTH_TRANSITION } };
      }
      if (cell === "o") {
        return { style: { opacity: MID_OPACITY, transition: SMOOTH_TRANSITION } };
      }
      return { style: { opacity: BASE_OPACITY, transition: SMOOTH_TRANSITION } };
    };
  }, [step]);

  return (
    <DotMatrixBase
      {...rest}
      size={size}
      dotSize={dotSize}
      speed={speed}
      pattern={pattern}
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={resolver}
    />
  );
}
