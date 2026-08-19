'use client';

import { cn } from '@/lib/utils';

export const Brain = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      className={cn('text-muted-foreground size-4', className)}
      style={{
        color: 'currentcolor',
        transitionProperty: 'color',
        transitionDuration: '150ms',
        transitionTimingFunction: 'cubic-bezier(0.31, 0.1, 0.08, 0.96)',
        transitionDelay: '0ms',
      }}
      viewBox="0 0 16 16"
      width="16"
    >
      <path
        d="M10 0c1.27 0 2.33.86 2.65 2.03a3 3 0 0 1 2.14 4.57 3.49 3.49 0 0 1-.05 5.34l.01.31A3.75 3.75 0 0 1 8 14.5a3.74 3.74 0 0 1-6.74-2.56 3.5 3.5 0 0 1-.05-5.34 2.99 2.99 0 0 1 2.14-4.57A2.75 2.75 0 0 1 8 .87C8.5.33 9.21 0 10 0Zm0 1.5c-.69 0-1.25.56-1.25 1.25V5A3.75 3.75 0 0 1 5 8.75v-1.5c1.24 0 2.25-1 2.25-2.25V2.75a1.25 1.25 0 1 0-2.4.48l.07.14.03.07a.75.75 0 0 1-1.29.75l-.04-.06-.08-.16a2.74 2.74 0 0 1-.17-.42 1.5 1.5 0 0 0-.83 2.33l.32-.07a.75.75 0 0 1 .28 1.47 2 2 0 0 0 .72 3.94.75.75 0 0 1 .28 1.47 3.51 3.51 0 0 1-1.35-.01 2.25 2.25 0 0 0 4.46-.43V12A3.75 3.75 0 0 1 11 8.25v1.5c-1.24 0-2.25 1-2.25 2.25v.25a2.25 2.25 0 0 0 4.46.43 3.51 3.51 0 0 1-1.35.01.75.75 0 0 1 .28-1.47 2 2 0 0 0 .73-3.93.75.75 0 0 1 .27-1.48l.32.07a1.5 1.5 0 0 0-.83-2.33c-.04.15-.1.29-.17.42l-.08.16-.04.06a.75.75 0 0 1-1.3-.75l.04-.07.07-.14A1.25 1.25 0 0 0 10 1.5Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
