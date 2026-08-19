'use client';

import { cn } from '@/lib/utils';

export const Plus = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 72 72"
      width="16"
      height="16"
      className={cn('size-4', className)}
    >
      <path
        d="M 36 13 C 33.791 13 32 14.791 32 17 L 32 32 L 17 32 C 14.791 32 13 33.791 13 36 C 13 38.209 14.791 40 17 40 L 32 40 L 32 55 C 32 57.209 33.791 59 36 59 C 38.209 59 40 57.209 40 55 L 40 40 L 55 40 C 57.209 40 59 38.209 59 36 C 59 33.791 57.209 32 55 32 L 40 32 L 40 17 C 40 14.791 38.209 13 36 13 z"
        fill="currentColor"
      />
    </svg>
  );
};
