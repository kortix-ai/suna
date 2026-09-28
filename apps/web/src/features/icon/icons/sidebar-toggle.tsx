'use client';

import { cn } from '@/lib/utils';

type SidebarToggleProps = React.SVGProps<SVGSVGElement> & {
  /** Flip horizontally so the filled column sits on the right (right-side panels). */
  mirrored?: boolean;
};

/**
 * A rounded panel frame split by a divider, drawn as strokes so the weight is
 * one number. 2.25 viewBox units is ~1.5px at the default 16px — the fill
 * outline this replaced was 1.77 units (~1.2px) and read as hairline next to
 * the Phosphor icons around it. The frame spans 21 × 19 of the 24 box (was
 * 20 × 17.7), so the glyph fills its square like its neighbours do.
 */
export const SidebarToggle = ({ className, mirrored, ...props }: SidebarToggleProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      aria-hidden="true"
      className={cn('size-4', mirrored && '-scale-x-100', className)}
      {...props}
    >
      <rect x="2.625" y="3.625" width="18.75" height="16.75" rx="4" />
      <path d="M9.25 3.625v16.75" />
    </svg>
  );
};
