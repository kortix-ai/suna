"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { rowMajorIndex } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare13Props = DotMatrixCommonProps;

type FrameCell = "." | "o" | "x";

const BASE_OPACITY = 0.08;
const ON_OPACITY = 0.56;
const PEAK_OPACITY = 1;

const FRAME_MASKS: readonly string[] = [
  // N
  "..x.." + "..x.." + "..o.." + "....." + ".....",
  // NE
  "....x" + "...x." + "..o.." + "....." + ".....",
  // E
  "....." + "....." + "..oxx" + "....." + ".....",
  // SE
  "....." + "....." + "..o.." + "...x." + "....x",
  // S
  "....." + "....." + "..o.." + "..x.." + "..x..",
  // SW
  "....." + "....." + "..o.." + ".x..." + "x....",
  // W
  "....." + "....." + "xxo.." + "....." + ".....",
  // NW
  "x...." + ".x..." + "..o.." + "....." + "....."
];

const FRAME_SEQUENCE: readonly number[] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];

function maskCell(mask: string, row: number, col: number): FrameCell {
  return (mask[rowMajorIndex(row, col)] as FrameCell | undefined) ?? ".";
}

export function DotmSquare13({
  speed = 1.85,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare13Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const sequenceLength = FRAME_SEQUENCE.length;
  const step = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle" && sequenceLength > 0,
    cycleMsBase: 1550,
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
        return { style: { opacity: PEAK_OPACITY } };
      }
      if (cell === "o") {
        return { style: { opacity: ON_OPACITY } };
      }
      return { style: { opacity: BASE_OPACITY } };
    };
  }, [step]);

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
      animationResolver={resolver}
    />
  );
}
