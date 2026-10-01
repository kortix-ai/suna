'use client';


import type { DotAnimationResolver, DotMatrixCommonProps } from '@/lib/dotmatrix-core';
import { createDotm5x5Component } from '@/lib/dotmatrix-core';

export type DotmSquare16Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const STRAND_OPACITY = 1;
const BRIDGE_OPACITY = 0.58;
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
      // Tighter center-band helix (3-column footprint).
      const left = Math.round(1.5 + 0.5 * Math.sin(rowPhase));
      const right = 4 - left;
      const bridgeOn = Math.cos(rowPhase * 2) > 0.82;

      if (col === left || col === right) {
        return { style: { opacity: STRAND_OPACITY } };
      }

      if (bridgeOn && col > left && col < right) {
        return { style: { opacity: BRIDGE_OPACITY } };
      }

      if (Math.abs(col - left) === 1 || Math.abs(col - right) === 1) {
        return { style: { opacity: NEAR_STRAND_OPACITY } };
      }

      return { style: { opacity: BASE_OPACITY } };
    };
}

export const DotmSquare16 = createDotm5x5Component('DotmSquare16', makeResolver, { speed: 2.5, cycleMsBase: 1400 });
