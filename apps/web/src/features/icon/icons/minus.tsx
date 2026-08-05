'use client';

import { cn } from '@/lib/utils';

export const Minus = ({ className }: { className?: string }) => {
  return (
    <svg
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4', className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M6 12h12" />
    </svg>
  );
};
