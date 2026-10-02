'use client';

import type { CSSProperties } from 'react';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component } from '@/lib/dotmatrix-core';


const animationResolver: DotAnimationResolver = ({
  isActive,
  manhattanDistance,
  reducedMotion,
  phase,
}) => {
  if (!isActive) {
    return { className: 'dmx-inactive' };
  }

  const ring = Math.max(0, Math.min(4, manhattanDistance));
  const style = {
    '--dmx-ripple-ring': ring,
    '--dmx-ripple-parity': ring % 2,
  } as CSSProperties;

  if (reducedMotion || phase === 'idle') {
    return {
      style: {
        ...style,
        opacity: 0.2 + (1 - ring / 4) * 0.72,
      },
    };
  }

  return { className: 'dmx-ripple-echo', style };
};

function makeResolver(): DotAnimationResolver {
  return animationResolver;
}

export const DotmSquare11 = createDotm5x5Component('DotmSquare11', makeResolver, { speed: 1.25 });
