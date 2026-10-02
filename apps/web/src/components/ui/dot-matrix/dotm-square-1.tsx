'use client';

import type { CSSProperties } from 'react';

import type { DotAnimationResolver } from '@/lib/dotmatrix-core';
import { createDotm5x5Component, trBlPathNormFromIndex } from '@/lib/dotmatrix-core';


const animationResolver: DotAnimationResolver = ({
  isActive,
  index,
  row,
  col,
  reducedMotion,
  phase,
}) => {
  if (!isActive) {
    return { className: 'dmx-inactive' };
  }

  const path = trBlPathNormFromIndex(index);
  const slice = row + (4 - col);
  const parity = slice % 2;
  const style = {
    '--dmx-path': path,
    '--dmx-diagonal-parity': parity,
  } as CSSProperties;

  if (reducedMotion || phase === 'idle') {
    return {
      style: {
        ...style,
        opacity: parity === 0 ? 0.88 : 0.14,
      },
    };
  }

  return { className: 'dmx-diagonal-alt-sweep', style };
};

function makeResolver(): DotAnimationResolver {
  return animationResolver;
}

export const DotmSquare1 = createDotm5x5Component('DotmSquare1', makeResolver, { speed: 1.1 });
