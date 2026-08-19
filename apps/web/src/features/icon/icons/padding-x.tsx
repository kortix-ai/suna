'use client';

import { cn } from '@/lib/utils';

export const PaddingX = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M15 14.1C14.94 14.61 14.52 15 14 15H2L1.9 15C1.43 14.95 1.05 14.573 1 14.1L1 14V2L1 1.9C1.05 1.43 1.43 1.05 1.9 1L2 1H14C14.52 1 14.94 1.39 15 1.9L15 2V14L15 14.1ZM2.5 2.5V13.5H13.5V2.5H2.5ZM4.27 12.375V3.625H5.67V12.375H4.27ZM10.333 12.375V3.625H11.73V12.375H10.333Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
