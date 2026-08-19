'use client';

import { cn } from '@/lib/utils';

export const PaddingBottom = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M14.1 1C14.61 1.06 15 1.48 15 2V14L15 14.1C14.95 14.57 14.57 14.95 14.1 15L14 15H2L1.9 15C1.43 14.95 1.05 14.57 1 14.1L1 14V2C1 1.48 1.39 1.06 1.9 1L2 1H14L14.1 1ZM2.5 13.5H13.5V2.5H2.5V13.5ZM12.38 11.73H3.62V10.33H12.38V11.73Z"
        fill="currentColor"
      />
    </svg>
  );
};
