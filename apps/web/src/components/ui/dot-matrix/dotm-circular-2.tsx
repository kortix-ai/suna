'use client';

import type { CSSProperties } from 'react';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, isWithinCircularMask, rowMajorIndex } from '@/lib/dotmatrix-core';


const RING_PATH: readonly number[] = [
  rowMajorIndex(0, 1),
  rowMajorIndex(0, 2),
  rowMajorIndex(0, 3),
  rowMajorIndex(1, 4),
  rowMajorIndex(2, 4),
  rowMajorIndex(3, 4),
  rowMajorIndex(4, 3),
  rowMajorIndex(4, 2),
  rowMajorIndex(4, 1),
  rowMajorIndex(3, 0),
  rowMajorIndex(2, 0),
  rowMajorIndex(1, 0),
];

const LOOP_LEN = RING_PATH.length;
const BASE_OPACITY = 0.08;

function makeResolver(_cycle: number, reducedMotion: boolean): DotAnimationResolver {
  return ({ index, row, col, phase }) => {
    if (!isWithinCircularMask(row, col)) {
      return { className: 'dmx-inactive' };
    }

    const onRing = RING_PATH.indexOf(index);
    if (onRing === -1) {
      return { style: { opacity: row === 2 && col === 2 ? 0.18 : BASE_OPACITY } };
    }

    if (reducedMotion || phase === 'idle') {
      return { style: { opacity: 0.28 + (onRing / (LOOP_LEN - 1)) * 0.58 } };
    }

    return {
      className: 'dmx-circular2-ring',
      style: { '--dmx-ring-order': onRing } as CSSProperties,
    };
  };
}

export const DotmCircular2 = createDotm5x5Component('DotmCircular2', makeResolver, { speed: 1.8, lockedPattern: 'full' });
