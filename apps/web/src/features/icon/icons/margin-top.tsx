'use client';

import { cn } from '@/lib/utils';

export const MarginTop = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M10.1025 5.00488C10.6067 5.05621 11 5.48232 11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6L5.89746 10.9951C5.42703 10.9472 5.05278 10.573 5.00488 10.1025L5 10V6C5 5.48232 5.39333 5.05621 5.89746 5.00488L6 5H10L10.1025 5.00488ZM6.5 9.5H9.5V6.5H6.5V9.5ZM15 3.5H1V2H15V3.5Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
