'use client';

import { cn } from '@/lib/utils';

export const ApparelMagic = ({ className }: { className?: string }) => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" className={cn('size-4', className)}>
      <path
        fill="#2377EA"
        d="m94.7 85.9-41.9-80.4c-0.9-1.7-2.4-3.1-4.7-3.1-2 0-3.7 1-4.7 2.8l-41.5 80.3c-1.5 2.7-0.7 5.7 1.6 7.3 2.5 1.5 6 1 7.3-1.9 3.1-5.7 21.1-38.8 37.2-71.5l29.3 56.5-26.8-14.3c-4.7-2.2-8.9 1.8-7.5 6.5 0.4 1 1.1 2.7 2.5 3.4l41.9 21.3c4.6 2.4 9.2-1.6 7.3-6.9z"
      />
    </svg>
  );
};
