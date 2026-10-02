'use client';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask } from '@/lib/dotmatrix-core';


const BASE_OPACITY = 0.08;
const ORBIT_OPACITY = 0.96;
const NEAR_ORBIT_OPACITY = 0.34;

function makeResolver(phase: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ row, col, phase: p }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const x = col - 2;
    const y = row - 2;
    const t = reducedMotion || p === 'idle' ? 0 : phase * Math.PI * 2;
    const angle = Math.atan2(y, x);
    const ring = Math.sqrt(x * x + y * y);

    const angularPhase = ((angle - t * 0.95 + Math.PI * 4) % (Math.PI * 2)) / ((Math.PI * 2) / 3);
    const sectorPos = angularPhase - Math.floor(angularPhase);
    const sectorPulse = Math.max(0, 1 - Math.abs(sectorPos - 0.5) * 2);
    const ringPhase = 0.5 + 0.5 * Math.cos(ring * 3.2 + t * 1.7);
    const score = 0.74 * sectorPulse + 0.26 * ringPhase;

    let opacity = BASE_OPACITY;
    if (score > 0.84) {
      opacity = ORBIT_OPACITY;
    } else if (score > 0.63) {
      opacity = 0.62;
    } else if (score > 0.44) {
      opacity = NEAR_ORBIT_OPACITY;
    }

    if (x === 0 && y === 0) {
      return { style: { opacity: Math.max(opacity, NEAR_ORBIT_OPACITY) } };
    }
    return { style: { opacity } };
  };
}

export const DotmCircular6 = createDotm5x5Component('DotmCircular6', makeResolver, { speed: 1.6, lockedPattern: 'full', cycleMsBase: 1700 });
