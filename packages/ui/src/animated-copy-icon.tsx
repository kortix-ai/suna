'use client';

import { AnimatePresence, m } from 'motion/react';
import type { ReactNode } from 'react';

export function AnimatedCopyIcon({ copied, children }: { copied: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <m.span
        key={copied ? 'check' : 'copy'}
        initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
        animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
        exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
        transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
        className="absolute inset-0 inline-flex items-center justify-center"
      >
        {children}
      </m.span>
    </AnimatePresence>
  );
}
