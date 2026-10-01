'use client';

import type { CSSProperties } from 'react';

import type { DotAnimationResolver, DotMatrixCommonProps } from '@/lib/dotmatrix-core';
import { createDotm5x5Component } from '@/lib/dotmatrix-core';

export type DotmSquare6Props = DotMatrixCommonProps;

const COLUMN_HEIGHT = 5;

function makeResolver(_cycle: number, reducedMotion: boolean): DotAnimationResolver {

    return ({ isActive, row, col, phase }) => {
      if (!isActive) {
        return { className: 'dmx-inactive' };
      }

      const goesUp = col % 2 === 0;
      const position = goesUp ? COLUMN_HEIGHT - 1 - row : row;

      if (reducedMotion || phase === 'idle') {
        return { style: { opacity: 0.22 + (position / (COLUMN_HEIGHT - 1)) * 0.66 } };
      }

      return {
        className: 'dmx-square6-col-snake',
        style: { '--dmx-col-pos': position } as CSSProperties,
      };
    };
}

export const DotmSquare6 = createDotm5x5Component('DotmSquare6', makeResolver, { speed: 2.2 });
