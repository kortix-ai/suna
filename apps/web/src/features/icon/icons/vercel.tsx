'use client';

import { cn } from '@/lib/utils';

export const Vercel = ({ className }: { className?: string }) => (
  <svg
    width="76"
    height="65"
    viewBox="0 0 76 65"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('size-4', className)}
  >
    <path d="M37.53 0L75.05 65H0L37.53 0Z" fill="currentColor" />
  </svg>
);
