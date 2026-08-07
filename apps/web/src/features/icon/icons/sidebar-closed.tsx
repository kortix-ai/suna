'use client';

import { cn } from '@/lib/utils';

export const SidebarClosed = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={cn('size-4', className)}
    >
      <rect
        x="0.5"
        y="2"
        width="15"
        height="12"
        rx="1.5"
        ry="1.5"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
      ></rect>
      <rect x="2" y="4" width="3.5" height="8" rx="0.5" fill="currentColor" opacity="0.4"></rect>
    </svg>
  );
};
