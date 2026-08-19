'use client';

import { cn } from '@/lib/utils';

export const Viktor = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 165.4 165.4"
      className={cn('text-foreground size-4', className)}
    >
      <defs>
        <linearGradient
          id="SVGID_1_"
          x1="82.78"
          x2="82.78"
          y1="-2.07"
          y2="164.7"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FDBB9A" offset="0" />
          <stop stopColor="#9C5BC6" offset=".5" />
          <stop stopColor="#562EEB" offset="1" />
        </linearGradient>
      </defs>
      <path
        d="M126.7 29.6h-32.8c-0.7 0-1.4 0.6-1.4 1.5v52.1c0 10.9-2.6 16.3-15.1 16.3h-3.8l-0.5-0.1v-68.2c0-0.7-0.5-1.5-1.3-1.6h-33.2c-0.8 0-1.5 0.7-1.6 1.4v102c0 0.7 0.5 1.2 1.2 1.2h40.4c12.2 0 25-3.9 33.3-9.4 10.4-7.6 16.3-18.4 16.3-31.2v-62.3c0-0.9-0.7-1.7-1.5-1.7z"
        fill="currentColor"
      />
    </svg>
  );
};
