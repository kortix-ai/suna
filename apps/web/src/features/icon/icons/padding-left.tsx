'use client';

import { cn } from '@/lib/utils';

export const PaddingLeft = ({ className }: { className?: string }) => {
  return (
    <svg
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
      className={cn('size-4', className)}
    >
      <path
        d="M14.9951 14.1025C14.9438 14.6067 14.5177 15 14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2L1.00488 1.89746C1.05278 1.42703 1.42703 1.05278 1.89746 1.00488L2 1H14C14.5177 1 14.9438 1.39333 14.9951 1.89746L15 2V14L14.9951 14.1025ZM2.5 2.5V13.5H13.5V2.5H2.5ZM4.2666 12.375V3.625H5.66699V12.375H4.2666Z"
        fill="currentColor"
      />
    </svg>
  );
};
