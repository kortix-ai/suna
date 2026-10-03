'use client';

import type { CSSProperties } from 'react';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import {
  diagonalSnakeNormFromIndex,
  diagonalSnakeOrderValue,
  createDotm5x5Component,
} from '@/lib/dotmatrix-core';


const animationResolver: DotAnimationResolver = ({ isActive, index, reducedMotion, phase }) => {
  if (!isActive) {
    return { className: 'dmx-inactive' };
  }

  const order = diagonalSnakeOrderValue(index);
  const pathNorm = diagonalSnakeNormFromIndex(index);
  const style = { '--dmx-diagonal-snake-order': order } as CSSProperties;

  if (reducedMotion || phase === 'idle') {
    return {
      style: {
        ...style,
        opacity: 0.16 + pathNorm * 0.78,
      },
    };
  }

  return { className: 'dmx-diagonal-snake', style };
};

function makeResolver(): DotAnimationResolver {
  return animationResolver;
}

export const DotmSquare5 = createDotm5x5Component('DotmSquare5', makeResolver, { speed: 1.35 });
