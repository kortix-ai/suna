'use client';


import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, MATRIX_SIZE } from '@/lib/dotmatrix-core';


const ROWS = MATRIX_SIZE;

const BASE_OPACITY = 0.08;
const PEAK_OPACITY = 1;
const DECAY = 0.72;
const COL_WARP = 0.07;

function makeResolver(cycle: number, reducedMotion: boolean): DotAnimationResolver {

    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: 'dmx-inactive' };
      }

      if (reducedMotion || phase === 'idle') {
        const falloff = (ROWS - 1 - row) / Math.max(1, ROWS - 1);
        return { style: { opacity: BASE_OPACITY + falloff * 0.38 } };
      }

      const colGain = 1 + COL_WARP * Math.sin(col * 1.72 + cycle * 0.61);

      if (row > cycle) {
        return { style: { opacity: BASE_OPACITY } };
      }

      const age = cycle - row;
      const trail = Math.exp(-age * DECAY);
      const opacity = BASE_OPACITY + (PEAK_OPACITY - BASE_OPACITY) * trail * colGain;

      return { style: { opacity: Math.min(PEAK_OPACITY, opacity) } };
    };
}

export const DotmSquare10 = createDotm5x5Component('DotmSquare10', makeResolver, { speed: 2.5, cycleMsBase: 1500, steps: ROWS });
