'use client';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask } from '@/lib/dotmatrix-core';


const BASE_OPACITY = 0.08;
const PULSE_CORE = 0.95;
const PULSE_RING = 0.44;

function makeResolver(phase: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ row, col, phase: p }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const x = col - 2;
    const y = row - 2;
    const radius = Math.hypot(x, y);
    const beat = reducedMotion || p === 'idle' ? 0 : Math.sin(phase * Math.PI * 2);
    const spike = reducedMotion || p === 'idle' ? 0 : Math.sin(phase * Math.PI * 4);
    const pulse = Math.max(0, beat) + Math.max(0, spike) * 0.55;

    if (radius < 0.55) {
      return { style: { opacity: Math.min(1, 0.35 + pulse * PULSE_CORE) } };
    }
    if (radius < 1.65) {
      return { style: { opacity: 0.16 + pulse * PULSE_RING } };
    }
    return { style: { opacity: BASE_OPACITY + pulse * 0.08 } };
  };
}

export const DotmCircular8 = createDotm5x5Component('DotmCircular8', makeResolver, { speed: 1.95, lockedPattern: 'full', cycleMsBase: 1400 });
