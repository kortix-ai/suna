"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { MATRIX_SIZE } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import { useSteppedCycle } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare8Props = DotMatrixCommonProps;

const ROWS = MATRIX_SIZE;
const COLS = MATRIX_SIZE;

/** Steps 0..FILL_LAST: column `c` gains one row from the bottom each tick, delayed by `c` (col 0 full at `ROWS`, last col at `ROWS + COLS - 1`). */
const FILL_LAST = ROWS + COLS - 1;

const BLINK_STEPS = 4;
const BLINK_OPACITIES = [0.38, 1, 0.38, 1] as const;

const DRAIN_LAST = FILL_LAST;

/** fillTick 0..FILL_LAST → drainTick 0..DRAIN_LAST → + blink in between */
const SEQUENCE_LEN = FILL_LAST + 1 + BLINK_STEPS + DRAIN_LAST + 1;

const BASE_OPACITY = 0.08;
const SETTLED_OPACITY = 0.52;
const CAP_OPACITY = 1;

function fillHeight(col: number, fillTick: number): number {
  return Math.max(0, Math.min(ROWS, fillTick - col));
}

function drainHeight(col: number, drainTick: number): number {
  return Math.max(0, Math.min(ROWS, ROWS - Math.max(0, drainTick - col)));
}

export function DotmSquare8({
  speed = 1.4,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare8Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  const step = useSteppedCycle({
    active: !reducedMotion && matrixPhase !== "idle" && SEQUENCE_LEN > 0,
    cycleMsBase: 2000,
    steps: SEQUENCE_LEN,
    speed,
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      if (reducedMotion || phase === "idle") {
        return { style: { opacity: BASE_OPACITY } };
      }

      let height = 0;
      let blinkOpacity: number | null = null;

      if (step <= FILL_LAST) {
        height = fillHeight(col, step);
      } else if (step < FILL_LAST + 1 + BLINK_STEPS) {
        height = ROWS;
        blinkOpacity = BLINK_OPACITIES[step - (FILL_LAST + 1)] ?? 1;
      } else {
        const drainTick = step - (FILL_LAST + 1 + BLINK_STEPS);
        height = drainHeight(col, drainTick);
      }

      const bottomRow = ROWS - 1;
      const topLitRow = ROWS - height;
      const isLit = height > 0 && row >= topLitRow && row <= bottomRow;
      if (!isLit) {
        return { style: { opacity: BASE_OPACITY } };
      }

      if (blinkOpacity !== null) {
        return { style: { opacity: blinkOpacity } };
      }

      const isCap = row === topLitRow && height > 0 && height < ROWS;
      return {
        style: { opacity: isCap ? CAP_OPACITY : SETTLED_OPACITY }
      };
    };
  }, [reducedMotion, step]);

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
