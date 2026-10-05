'use client';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask } from '@/lib/dotmatrix-core';


const BASE_OPACITY = 0.07;
const MID_OPACITY = 0.3;
const HIGH_OPACITY = 0.95;

function makeResolver(phase: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ row, col, phase: p }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const x = col - 2;
    const y = row - 2;
    const ring = Math.sqrt(x * x + y * y);
    const t = reducedMotion || p === 'idle' ? 0 : phase * Math.PI * 2;
    const angle = Math.atan2(y, x);
    const moonCenterX = Math.cos(t) * 0.7;
    const moonCenterY = Math.sin(t) * 0.7;
    const body = Math.hypot(x - moonCenterX, y - moonCenterY);
    const cutCenterX = moonCenterX + Math.cos(t) * 0.82;
    const cutCenterY = moonCenterY + Math.sin(t) * 0.82;
    const cut = Math.hypot(x - cutCenterX, y - cutCenterY);
    const rim = Math.max(0, 1 - Math.abs(body - 1.55) / 0.35);
    const halo = Math.max(0, 1 - Math.acos(Math.cos(angle - t)) / 0.9);

    let opacity = BASE_OPACITY;
    if (body < 1.55 && cut > 1.05) {
      opacity = HIGH_OPACITY;
    } else if (rim > 0.5) {
      opacity = MID_OPACITY + rim * 0.22;
    } else if (halo > 0.68 && ring > 1.2) {
      opacity = MID_OPACITY;
    }

    return { style: { opacity: Math.min(HIGH_OPACITY, opacity) } };
  };
}

export const DotmCircular11 = createDotm5x5Component('DotmCircular11', makeResolver, { speed: 1.65, lockedPattern: 'full', cycleMsBase: 1850 });
