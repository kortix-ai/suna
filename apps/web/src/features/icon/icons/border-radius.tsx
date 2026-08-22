'use client';

import { cn } from '@/lib/utils';

export const BorderRadius = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      className={cn('size-4', className)}
      viewBox="0 0 16 16"
      width="16"
    >
      <path
        d="M13.97 3.25H7.72C5.82 3.25 4.29 4.79 4.29 6.69V14.5H2.79V6.69C2.79 3.96 5 1.75 7.72 1.75H13.97V3.25Z"
        fill="#666666"
      ></path>
    </svg>
  );
};
