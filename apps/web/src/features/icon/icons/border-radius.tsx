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
        d="M13.9658 3.25024H7.72168C5.82405 3.25024 4.28522 4.78817 4.28516 6.68579V14.5002H2.78516V6.68579C2.78522 3.95975 4.99562 1.75024 7.72168 1.75024H13.9658V3.25024Z"
        fill="#666666"
      ></path>
    </svg>
  );
};
