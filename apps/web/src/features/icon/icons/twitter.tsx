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
        d="M17.6874 3.0625L12.6907 8.77425L8.37045 3.0625H2.11328L9.58961 12.8387L2.50378 20.9375H5.53795L11.0068 14.6886L15.7863 20.9375H21.8885L14.095 10.6342L20.7198 3.0625H17.6874ZM16.6232 19.1225L5.65436 4.78217H7.45745L18.3034 19.1225H16.6232Z"
        fill="currentColor"
      />
    </svg>
  );
};
