'use client';

import { cn } from '@/lib/utils';

export const Moon = ({ className }: { className?: string }) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-4', className)}
    >
      <path
        d="M12.05 3.6C12.27 3.28 12.29 2.86 12.09 2.53C11.9 2.2 11.53 2 11.14 2.04C6.02 2.47 2 6.76 2 12C2 17.52 6.48 22 12 22C17.23 22 21.53 17.97 21.96 12.85C21.99 12.47 21.8 12.1 21.47 11.9C21.13 11.71 20.71 11.72 20.4 11.94C19.43 12.61 18.26 13 17 13C13.68 13 11 10.31 11 7C11 5.74 11.39 4.57 12.05 3.6Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
