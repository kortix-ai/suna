'use client';

import { cn } from '@/lib/utils';

export const HamBurger = ({ className }: { className?: string }) => {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('text-primary size-4', className)}
    >
      <rect
        x="1"
        y="7.5"
        width="14"
        height="1.5"
        rx="0.5"
        color="currentColor"
        fill="currentColor"
        style={{
          transformOrigin: 'center',
          transition: '160ms var(--ease-out-quad)',
          transform: 'translateY(-3px)',
        }}
      ></rect>
      <rect
        x="1"
        y="7.5"
        width="14"
        height="1.5"
        rx="0.5"
        color="currentColor"
        fill="currentColor"
        style={{
          transformOrigin: 'center',
          transition: '160ms var(--ease-out-quad)',
          transform: 'translateY(3px)',
        }}
      ></rect>
    </svg>
  );
};
