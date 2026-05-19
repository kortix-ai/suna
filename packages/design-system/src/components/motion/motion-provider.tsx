'use client';

import { MotionConfig } from 'motion/react';
import * as React from 'react';
import { springs } from '../../lib/motion';

export interface MotionProviderProps {
  children: React.ReactNode;
}

export function MotionProvider({ children }: MotionProviderProps) {
  return (
    <MotionConfig reducedMotion="user" transition={springs.moderate}>
      {children}
    </MotionConfig>
  );
}
