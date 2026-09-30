'use client';

import { cn } from '@/lib/utils';

export const SolidCheckIcon = ({ className, ...props }: React.ComponentProps<'svg'>) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      className={cn('size-4 shrink-0', className)}
      {...props}
    >
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10s10-4.5 10-10S17.5 2 12 2zm4.2 8.3l-4.8 4.8c-.4.4-1 .4-1.4 0l-2.2-2.2c-.4-.4-.4-1 0-1.4c.4-.4 1-.4 1.4 0l1.5 1.5l4.1-4.1c.4-.4 1-.4 1.4 0c.4.4.4 1 0 1.4z" />
    </svg>
  );
};
