'use client';

import type { DotAnimationResolver, DotMatrixCommonProps } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask } from '@/lib/dotmatrix-core';

export type DotmCircular4Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;
const SWEEP_OPACITY = 0.96;
const NEAR_SWEEP_OPACITY = 0.36;
const RING_OPACITY = 0.22;

function makeResolver(phase: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ row, col, phase: p }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const centerRow = row - 2;
    const centerCol = col - 2;
    const radius = Math.hypot(centerRow, centerCol);
    const theta = (reducedMotion || p === 'idle' ? 0 : phase) * Math.PI * 2;
    const sweepX = Math.cos(theta);
    const sweepY = Math.sin(theta);
    const projection = centerCol * sweepX + centerRow * sweepY;
    const perpendicular = Math.abs(centerCol * sweepY - centerRow * sweepX);

    if (radius < 0.5) {
      return { style: { opacity: 0.62 } };
    }

    if (projection > 0.3 && perpendicular < 0.55) {
      return { style: { opacity: SWEEP_OPACITY } };
    }

    if (projection > 0 && perpendicular < 1.15) {
      return { style: { opacity: NEAR_SWEEP_OPACITY } };
    }

    if (radius > 1.6 && radius < 2.3) {
      return { style: { opacity: RING_OPACITY } };
    }

    return { style: { opacity: BASE_OPACITY } };
  };
}

export const DotmCircular4 = createDotm5x5Component('DotmCircular4', makeResolver, { speed: 1.55, lockedPattern: 'full', cycleMsBase: 1800 });
