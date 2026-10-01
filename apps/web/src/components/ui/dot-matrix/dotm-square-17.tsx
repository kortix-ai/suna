'use client';


import type { DotAnimationResolver, DotMatrixCommonProps } from '@/lib/dotmatrix-core';
import { createDotm5x5Component } from '@/lib/dotmatrix-core';

export type DotmSquare17Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const STRAND_OPACITY = 1;
const NEAR_STRAND_OPACITY = 0.24;
const STEP_COUNT = 20;
const HELIX_LOOP_RADIANS = (Math.PI * 2) / (STEP_COUNT - 1);

function makeResolver(cycle: number, reducedMotion: boolean): DotAnimationResolver {

    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: 'dmx-inactive' };
      }

      const t = reducedMotion || phase === 'idle' ? 0 : cycle * STEP_COUNT;
      // Make first and last discrete frames identical to avoid loop jank.
      const rowPhase = t * HELIX_LOOP_RADIANS + row * 1.24;
      // One helix strand only, sweeping across full 5-column width.
      const strandCol = Math.round(2 + 2 * Math.sin(rowPhase));

      if (col === strandCol) {
        return { style: { opacity: STRAND_OPACITY } };
      }

      if (Math.abs(col - strandCol) === 1) {
        return { style: { opacity: NEAR_STRAND_OPACITY } };
      }

      return { style: { opacity: BASE_OPACITY } };
    };
}

export const DotmSquare17 = createDotm5x5Component('DotmSquare17', makeResolver, { speed: 2.5, cycleMsBase: 1600 });
