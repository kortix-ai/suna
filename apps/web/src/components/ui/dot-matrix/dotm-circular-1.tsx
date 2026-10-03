'use client';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask } from '@/lib/dotmatrix-core';


const BASE_OPACITY = 0.08;
const STRAND_OPACITY = 1;
const NEAR_STRAND_OPACITY = 0.24;
const STEP_COUNT = 20;
const HELIX_LOOP_RADIANS = (Math.PI * 2) / (STEP_COUNT - 1);

function makeResolver(animPhase: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ row, col, phase }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const t = reducedMotion || phase === 'idle' ? 0 : animPhase * STEP_COUNT;
    const diagonalAxis = row + col;
    const phaseOffset = t * HELIX_LOOP_RADIANS + diagonalAxis * 0.82;
    const strandPerpendicular = Math.round(2 * Math.sin(phaseOffset));
    const cellPerpendicular = col - row;
    const distanceFromStrand = Math.abs(cellPerpendicular - strandPerpendicular);

    if (distanceFromStrand === 0) {
      return { style: { opacity: STRAND_OPACITY } };
    }

    if (distanceFromStrand === 1) {
      return { style: { opacity: NEAR_STRAND_OPACITY } };
    }

    return { style: { opacity: BASE_OPACITY } };
  };
}

export const DotmCircular1 = createDotm5x5Component('DotmCircular1', makeResolver, { speed: 2.5, lockedPattern: 'full', cycleMsBase: 1700 });
