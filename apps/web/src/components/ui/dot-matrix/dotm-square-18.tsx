'use client';


import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component } from '@/lib/dotmatrix-core';


const BASE_OPACITY = 0.08;
const LIT_OPACITY = 0.94;
const CAP_OPACITY = 1;
const STEP_COUNT = 24;
const MAX_LEVEL = 5;

function clampLevel(value: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, Math.round(value)));
}

function makeResolver(cycle: number, reducedMotion: boolean): DotAnimationResolver {

    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: 'dmx-inactive' };
      }

      const t = reducedMotion || phase === 'idle' ? 0 : cycle * STEP_COUNT;
      const colPhase = t * 0.52 + col * 1.15;
      const level = clampLevel(1 + ((Math.sin(colPhase) + 1) / 2) * (MAX_LEVEL - 1));
      const topLitRow = MAX_LEVEL - level;

      if (row > topLitRow) {
        return { style: { opacity: LIT_OPACITY } };
      }
      if (row === topLitRow) {
        return { style: { opacity: CAP_OPACITY } };
      }
      return { style: { opacity: BASE_OPACITY } };
    };
}

export const DotmSquare18 = createDotm5x5Component('DotmSquare18', makeResolver, { speed: 1.35, cycleMsBase: 1750 });
