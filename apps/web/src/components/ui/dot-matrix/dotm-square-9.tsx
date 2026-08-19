"use client";

import { useMemo } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmSquare9Props = DotMatrixCommonProps;

/**
 * Dots 1–6 in Unicode / ISO braille numbering (matches U+2800 + mask):
 *   1·4
 *   2·5
 *   3·6
 */
const D1 = 0x01;
const D2 = 0x02;
const D3 = 0x04;
const D4 = 0x08;
const D5 = 0x10;
const D6 = 0x20;

/** Left column “odd” / right column “even” — classic 2×3 checkerboard. */
const CHECK_A = D1 | D3 | D5;

const BASE_OPACITY = 0.08;
const MID_OPACITY = 0.26;
const GAP_OPACITY = 0.12;

const CELL_ROW_START = 1;
const LEFT_COL = 0;
const RIGHT_CELL_COL = 3;

function brailleBitForCell(row: number, col: number, cellColStart: number): number | null {
  if (row < CELL_ROW_START || row > CELL_ROW_START + 2) {
    return null;
  }
  const dr = row - CELL_ROW_START;
  if (col === cellColStart) {
    return D1 << dr;
  }
  if (col === cellColStart + 1) {
    return D4 << dr;
  }
  return null;
}

function resolveBraille(row: number, col: number): { bit: number } | null {
  const left = brailleBitForCell(row, col, LEFT_COL);
  if (left !== null) {
    return { bit: left };
  }
  const right = brailleBitForCell(row, col, RIGHT_CELL_COL);
  if (right !== null) {
    return { bit: right };
  }
  return null;
}

export function DotmSquare9({
  speed = 1.5,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmSquare9Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });

  const resolver = useMemo<DotAnimationResolver>(() => {
    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: "dmx-inactive" };
      }

      const braille = resolveBraille(row, col);

      if (reducedMotion || phase === "idle") {
        if (braille) {
          const mask = CHECK_A;
          const on = (mask & braille.bit) !== 0;
          return { style: { opacity: on ? MID_OPACITY : BASE_OPACITY } };
        }
        if (row >= CELL_ROW_START && row <= CELL_ROW_START + 2 && col === 2) {
          return { style: { opacity: GAP_OPACITY } };
        }
        return { style: { opacity: BASE_OPACITY } };
      }

      if (row >= CELL_ROW_START && row <= CELL_ROW_START + 2 && col === 2) {
        return { style: { opacity: GAP_OPACITY } };
      }

      if (!braille) {
        return { style: { opacity: BASE_OPACITY } };
      }

      let bitClass = "dmx-square9-d1";
      if (braille.bit === D2) {
        bitClass = "dmx-square9-d2";
      } else if (braille.bit === D3) {
        bitClass = "dmx-square9-d3";
      } else if (braille.bit === D4) {
        bitClass = "dmx-square9-d4";
      } else if (braille.bit === D5) {
        bitClass = "dmx-square9-d5";
      } else if (braille.bit === D6) {
        bitClass = "dmx-square9-d6";
      }

      return { className: `dmx-square9-bit ${bitClass}` };
    };
  }, [reducedMotion]);

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
