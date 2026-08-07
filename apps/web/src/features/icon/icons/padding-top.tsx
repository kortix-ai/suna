'use client';

import { cn } from '@/lib/utils';

export const PaddingTop = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M14.1025 1.00488C14.6067 1.05621 15 1.48232 15 2V14L14.9951 14.1025C14.9472 14.573 14.573 14.9472 14.1025 14.9951L14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2C1 1.48232 1.39333 1.05621 1.89746 1.00488L2 1H14L14.1025 1.00488ZM2.5 13.5H13.5V2.5H2.5V13.5ZM12.375 5.66699H3.625V4.2666H12.375V5.66699Z"
        fill="currentColor"
      />
    </svg>
  );
};
