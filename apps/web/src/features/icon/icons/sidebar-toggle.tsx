'use client';

import { cn } from '@/lib/utils';

type SidebarToggleProps = React.SVGProps<SVGSVGElement> & {
  /** Flip horizontally so the filled column sits on the right (right-side panels). */
  mirrored?: boolean;
};

export const SidebarToggle = ({ className, mirrored, ...props }: SidebarToggleProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn('size-4', mirrored && '-scale-x-100', className)}
      {...props}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.416 4.767a2.65 2.65 0 0 0-2.65 2.65v8.832a2.65 2.65 0 0 0 2.65 2.65h1.461V4.767h-1.46Zm0-1.767A4.416 4.416 0 0 0 2 7.416v8.833a4.416 4.416 0 0 0 4.416 4.417h11.168A4.416 4.416 0 0 0 22 16.248V7.416A4.416 4.416 0 0 0 17.584 3zm3.228 1.767v14.132h7.94a2.65 2.65 0 0 0 2.65-2.65V7.416a2.65 2.65 0 0 0-2.65-2.65h-7.94Z"
        clipRule="evenodd"
      />
    </svg>
  );
};
