'use client';

import { cn } from '@/lib/utils';

export const MarginLeft = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M5.00488 5.89746C5.05621 5.39333 5.48232 5 6 5H10L10.1025 5.00488C10.573 5.05278 10.9472 5.42703 10.9951 5.89746L11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6C5.48232 11 5.05621 10.6067 5.00488 10.1025L5 10V6L5.00488 5.89746ZM9.5 9.5V6.5H6.5L6.5 9.5H9.5ZM3.5 1L3.5 15H2L2 1H3.5Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
