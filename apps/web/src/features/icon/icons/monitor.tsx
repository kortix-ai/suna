'use client';

import { cn } from '@/lib/utils';

export const Monitor = ({ className }: { className?: string }) => {
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
        d="M6 3C3.79 3 2 4.79 2 7V12H22V7C22 4.79 20.21 3 18 3H6Z"
        fill="currentColor"
      ></path>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 14H22C22 16.21 20.21 18 18 18H15V21C15 21.55 14.55 22 14 22H10C9.45 22 9 21.55 9 21V18H6C3.79 18 2 16.21 2 14ZM11 18V20H13V18H11Z"
        fill="currentColor"
      ></path>
    </svg>
  );
};
