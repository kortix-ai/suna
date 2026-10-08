'use client';

import { cn } from '@/lib/utils';

// Third-party brand colors, from the vendor's mark.
const CLAUDE_ORANGE = '#D97757';

/** The Claude Code mark: the pixel critter in Claude orange. */
export const ClaudeCode = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className={cn('size-4', className)}
  >
    <path
      fill={CLAUDE_ORANGE}
      d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z"
    />
  </svg>
);
