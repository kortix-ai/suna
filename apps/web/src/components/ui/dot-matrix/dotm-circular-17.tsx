'use client';

import type { DotAnimationResolver, DotMatrixCommonProps } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask } from '@/lib/dotmatrix-core';

export type DotmCircular17Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.07;
const MID_OPACITY = 0.34;
const HIGH_OPACITY = 0.95;
/** Discrete checker frames per loop (must stay integer for `(row + col + t) % 2`). */
const CHECKER_STEPS = 4;

function makeResolver(animPhase: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ row, col, phase: dmxPhase }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const holdStill = reducedMotion || dmxPhase === 'idle';
    const t = holdStill ? 0 : Math.floor(animPhase * CHECKER_STEPS) % CHECKER_STEPS;
    const parity = (row + col + t) % 2;
    const brailleBias = col === 1 || col === 3;
    const centerBias = row === 2 || col === 2;

    let opacity = BASE_OPACITY;
    if (parity === 0 && brailleBias) {
      opacity = HIGH_OPACITY;
    } else if (parity === 0 || centerBias) {
      opacity = MID_OPACITY;
    } else if (brailleBias) {
      opacity = 0.24;
    }

    return { style: { opacity } };
  };
}

export const DotmCircular17 = createDotm5x5Component('DotmCircular17', makeResolver, { speed: 1.55, lockedPattern: 'full', cycleMsBase: 1500 });
