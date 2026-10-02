'use client';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask } from '@/lib/dotmatrix-core';


const STEP_COUNT = 30;
const BASE_OPACITY = 0.07;
const RUNG_OPACITY = 0.95;
const SIDE_OPACITY = 0.56;
const GHOST_OPACITY = 0.28;

function makeResolver(animPhase: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ row, col, phase }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const x = col - 2;
    const y = row - 2;
    const phaseStep = reducedMotion || phase === 'idle' ? 0 : Math.floor(animPhase * 10);
    const activeRow = (phaseStep + 5) % 5;
    const rowDistance = Math.abs(row - activeRow);
    const swing = Math.sin((phaseStep / 10) * Math.PI * 2 + y * 0.9);
    const leftAnchor = Math.round(1 + swing);
    const rightAnchor = 4 - leftAnchor;

    let opacity = BASE_OPACITY;
    if (row === activeRow && col >= leftAnchor && col <= rightAnchor) {
      opacity = RUNG_OPACITY;
    } else if ((col === leftAnchor || col === rightAnchor) && rowDistance <= 1) {
      opacity = SIDE_OPACITY;
    } else if ((col === leftAnchor || col === rightAnchor) && rowDistance === 2) {
      opacity = GHOST_OPACITY;
    }

    if (x === 0 && y === 0 && rowDistance <= 1) {
      return { style: { opacity: Math.max(opacity, SIDE_OPACITY) } };
    }

    return { style: { opacity } };
  };
}

export const DotmCircular14 = createDotm5x5Component('DotmCircular14', makeResolver, { speed: 1.75, lockedPattern: 'full', cycleMsBase: 1650 });
