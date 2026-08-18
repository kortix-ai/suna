'use client';

import { cn } from '@/lib/utils';

export const Supabase = ({ className }: { className?: string }) => {
  return (
    <svg
      width="113"
      height="113"
      viewBox="0 0 113 113"
      className={cn('size-4', className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M63.71 110.28C60.85 113.89 55.05 111.91 54.98 107.31L53.97 40.06L99.19 40.06C107.38 40.06 111.95 49.52 106.86 55.94L63.71 110.28Z"
        fill="#3ECF8E"
      ></path>
      <path
        d="M45.32 2.07C48.18 -1.53 53.97 0.44 54.04 5.04L54.48 72.29H9.83C1.64 72.29 -2.93 62.83 2.17 56.42L45.32 2.07Z"
        fill="#3ECF8E"
      ></path>
      <defs>
        <linearGradient
          id="paint0_linear"
          x1="53.9738"
          y1="54.974"
          x2="94.1635"
          y2="71.8295"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#249361"></stop>
          <stop offset="1" stopColor="#3ECF8E"></stop>
        </linearGradient>
        <linearGradient
          id="paint1_linear"
          x1="36.1558"
          y1="30.578"
          x2="54.4844"
          y2="65.0806"
          gradientUnits="userSpaceOnUse"
        >
          <stop></stop>
          <stop offset="1" stopOpacity="0"></stop>
        </linearGradient>
      </defs>
    </svg>
  );
};
