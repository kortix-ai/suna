'use client';

import { cn } from '@/lib/utils';

export const Linear = ({ className }: { className?: string }) => {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('text-primary size-4', className)}
    >
      <path
        d="M3.04 12.94C3.24 14.92 4.1 16.85 5.62 18.364C7.14 19.88 9.06 20.74 11.04 20.95L3.04 12.94Z"
        fill="currentColor"
      />
      <path
        d="M3 11.49L12.49 20.99C13.3 20.94 14.1 20.79 14.87 20.53L3.46 9.12C3.2 9.89 3.05 10.69 3 11.49Z"
        fill="currentColor"
      />
      <path
        d="M3.87 8.11L15.88 20.12C16.5 19.82 17.09 19.45 17.65 19L4.99 6.34C4.54 6.89 4.17 7.487 3.87 8.11Z"
        fill="currentColor"
      />
      <path
        d="M5.66 5.6C9.18 2.12 14.85 2.135 18.35 5.64C21.85 9.14 21.86 14.8 18.39 18.32L5.66 5.6Z"
        fill="currentColor"
      />
    </svg>
  );
};
