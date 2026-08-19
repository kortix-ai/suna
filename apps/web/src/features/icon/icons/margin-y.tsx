'use client';

import { cn } from '@/lib/utils';

export const MarginY = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M15 14H1V12.5H15V14ZM10.1 5C10.61 5.06 11 5.48 11 6V10L11 10.1C10.95 10.57 10.57 10.95 10.1 11L10 11H6L5.9 11C5.43 10.95 5.05 10.57 5 10.1L5 10V6C5 5.48 5.39 5.06 5.9 5L6 5H10L10.1 5ZM6.5 9.5H9.5V6.5H6.5V9.5ZM15 3.5H1V2H15V3.5Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
