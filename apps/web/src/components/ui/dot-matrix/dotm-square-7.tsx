'use client';


import type { DotAnimationResolver, DotMatrixCommonProps } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, rowMajorIndex } from '@/lib/dotmatrix-core';

export type DotmSquare7Props = DotMatrixCommonProps;

type FrameCell = '.' | 'o' | 'x' | 'c';

const BASE_OPACITY = 0.08;
const SETTLED_OPACITY = 0.42;
const ACTIVE_OPACITY = 1;
const CLEAR_OPACITY = 0.88;
const IDLE_STEP = 10;

const FRAME_MASKS: readonly string[] = [
  '.....' + '.....' + '.....' + '.....' + 'ooooo',
  '.....' + '.....' + '.....' + 'ooooo' + 'ooooo',
  '.....' + '.....' + 'ooooo' + 'ooooo' + 'ooooo',
  '.....' + 'ooooo' + 'ooooo' + 'ooooo' + 'ooooo',
  'ooooo' + 'ooooo' + 'ooooo' + 'ooooo' + 'ooooo',
  'ccccc' + 'ccccc' + 'ccccc' + 'ccccc' + 'ccccc',
  '.....' + '.....' + '.....' + '.....' + '.....',
  'ccccc' + 'ccccc' + 'ccccc' + 'ccccc' + 'ccccc',
  '.....' + '.....' + '.....' + '.....' + '.....',
  '.....' + '.....' + '.....' + '.....' + '.....',
];

const FRAME_SEQUENCE: readonly number[] = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9];

function maskCell(mask: string, row: number, col: number): FrameCell {
  return (mask[rowMajorIndex(row, col)] as FrameCell | undefined) ?? '.';
}

function makeResolver(cycle: number, reducedMotion: boolean): DotAnimationResolver {

  const frame = FRAME_SEQUENCE[cycle] ?? FRAME_SEQUENCE[0] ?? 0;

    return ({ isActive, row, col }) => {
      if (!isActive) {
        return { className: 'dmx-inactive' };
      }

      const cell = maskCell(FRAME_MASKS[frame]!, row, col);
      if (cell === 'x') {
        return { style: { opacity: ACTIVE_OPACITY } };
      }
      if (cell === 'o') {
        return { style: { opacity: SETTLED_OPACITY } };
      }
      if (cell === 'c') {
        return { style: { opacity: CLEAR_OPACITY } };
      }
      return { style: { opacity: BASE_OPACITY } };
    };
}

export const DotmSquare7 = createDotm5x5Component('DotmSquare7', makeResolver, { speed: 1.35, cycleMsBase: 1900, steps: FRAME_SEQUENCE.length, idleStep: Math.min(IDLE_STEP, FRAME_SEQUENCE.length - 1) });
