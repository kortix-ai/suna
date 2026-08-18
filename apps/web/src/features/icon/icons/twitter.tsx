'use client';

import { cn } from '@/lib/utils';

export const Twitter = ({ className }: { className?: string }) => {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('text-foreground size-6', className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M17.69 3.06L12.69 8.77L8.37 3.06H2.11L9.59 12.84L2.5 20.94H5.54L11.01 14.69L15.79 20.94H21.89L14.1 10.63L20.72 3.06H17.69ZM16.62 19.12L5.65 4.78H7.46L18.3 19.12H16.62Z"
        fill="currentColor"
      />
    </svg>
  );
};
