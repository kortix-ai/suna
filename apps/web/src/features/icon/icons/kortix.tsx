'use client';

import { cn } from '@/lib/utils';

export const Kortix = ({ className }: { className?: string }) => {
  return (
    <svg
      width="30"
      height="25"
      viewBox="0 0 30 25"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('text-foreground size-4', className)}
    >
      <path
        d="M25.56 24.916H29.83C29.83 19.63 26.94 15 22.62 12.46C26.94 9.91 29.83 5.29 29.83 0H25.56C25.56 5 21.89 9.19 17.07 10.17V0H12.8V10.17C7.95 9.2 4.3 5.02 4.3 0H0.04C0.04 5.29 2.93 9.91 7.25 12.46C2.93 15 0.04 19.63 0.04 24.916H4.3C4.3 19.9 7.95 15.71 12.8 14.75V24.92H17.07V14.75C21.91 15.71 25.56 19.9 25.56 24.916Z"
        fill="currentColor"
      />
    </svg>
  );
};
