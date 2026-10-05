'use client';


import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component } from '@/lib/dotmatrix-core';


const BASE_OPACITY = 0.08;
const STRAND_OPACITY = 1;
const BRIDGE_OPACITY = 0.58;
const NEAR_STRAND_OPACITY = 0.24;
/** Integer full sin periods per matrix cycle so phase 0 ≡ phase 1 (no wrap glitch). */
const STRAND_LOOPS = 2;

function makeResolver(cycle: number, reducedMotion: boolean): DotAnimationResolver {

    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: 'dmx-inactive' };
      }

      const u = reducedMotion || phase === 'idle' ? 0 : cycle;
      const rowPhase = u * STRAND_LOOPS * 2 * Math.PI + row * 1.24;
      const left = Math.round(1 + Math.sin(rowPhase));
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

export const DotmSquare15 = createDotm5x5Component('DotmSquare15', makeResolver, { speed: 1.25, cycleMsBase: 1600 });
