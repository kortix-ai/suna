'use client';


import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, rowMajorIndex } from '@/lib/dotmatrix-core';


type FrameCell = '.' | 'o' | 'x';

const BASE_OPACITY = 0.08;
const ON_OPACITY = 0.56;
const PEAK_OPACITY = 1;

const FRAME_MASKS: readonly string[] = [
  // N
  '..x..' + '..x..' + '..o..' + '.....' + '.....',
  // NE
  '....x' + '...x.' + '..o..' + '.....' + '.....',
  // E
  '.....' + '.....' + '..oxx' + '.....' + '.....',
  // SE
  '.....' + '.....' + '..o..' + '...x.' + '....x',
  // S
  '.....' + '.....' + '..o..' + '..x..' + '..x..',
  // SW
  '.....' + '.....' + '..o..' + '.x...' + 'x....',
  // W
  '.....' + '.....' + 'xxo..' + '.....' + '.....',
  // NW
  'x....' + '.x...' + '..o..' + '.....' + '.....',
];

const FRAME_SEQUENCE: readonly number[] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];

function maskCell(mask: string, row: number, col: number): FrameCell {
  return (mask[rowMajorIndex(row, col)] as FrameCell | undefined) ?? '.';
}

function makeResolver(cycle: number, reducedMotion: boolean): DotAnimationResolver {

    const frameIndex = FRAME_SEQUENCE[cycle] ?? 0;
    const mask = FRAME_MASKS[frameIndex] ?? FRAME_MASKS[0]!;

    return ({ isActive, row, col }) => {
      if (!isActive) {
        return { className: 'dmx-inactive' };
      }

      const cell = maskCell(mask, row, col);
      if (cell === 'x') {
        return { style: { opacity: PEAK_OPACITY } };
      }
      if (cell === 'o') {
        return { style: { opacity: ON_OPACITY } };
      }
      return { style: { opacity: BASE_OPACITY } };
    };
}

export const DotmSquare13 = createDotm5x5Component('DotmSquare13', makeResolver, { speed: 1.85, cycleMsBase: 1550, steps: FRAME_SEQUENCE.length });
