'use client';

import { cn } from '@/lib/utils';

export const MarginRight = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M14 1V15H12.5V1H14ZM5 5.9C5.06 5.39 5.48 5 6 5H10L10.1 5C10.57 5.05 10.95 5.43 11 5.9L11 6V10L11 10.1C10.95 10.57 10.57 10.95 10.1 11L10 11H6C5.48 11 5.06 10.61 5 10.1L5 10L5 6L5 5.9ZM9.5 9.5V6.5H6.5V9.5H9.5Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
