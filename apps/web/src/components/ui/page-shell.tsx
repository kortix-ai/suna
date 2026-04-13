'use client';

/**
 * Kortix <PageShell> — the one layout wrapper every management page uses.
 *
 * Standardises max-width, horizontal padding, and scroll behavior so the
 * /triggers, /channels, /tunnel, /connectors, project About tab, etc. all
 * inherit the exact same rhythm.
 *
 * Pick a width via the `width` prop:
 *   • 'reading' → 720px   — text-heavy pages, About tab, editor
 *   • 'default' → 1000px  — lists + detail panels, the common case
 *   • 'wide'    → 1280px  — grids, boards, tables
 *   • 'full'    → 100%    — no max width (use sparingly)
 *
 * The shell does NOT render a page header — use <PageShell.Header> or the
 * existing <PageHeader> from components/ui, whichever fits the page.
 */

import { cn } from '@/lib/utils';
import type { ReactNode, HTMLAttributes } from 'react';

type Width = 'reading' | 'default' | 'wide' | 'full';

// Widths align with the canonical Kortix container. The
// `default` width matches the `container mx-auto max-w-7xl` used across
// /scheduled-tasks, /channels, /tunnel, /connectors so PageShell-based
// surfaces stack under the same rhythm as the rest of the app.
const WIDTH_CLASS: Record<Width, string> = {
  reading: 'max-w-[720px]',
  default: 'max-w-7xl',
  wide:    'max-w-[1400px]',
  full:    'max-w-none',
};

export interface PageShellProps extends HTMLAttributes<HTMLDivElement> {
  width?: Width;
  /** Disable vertical padding (useful when a sub-component controls spacing) */
  flush?: boolean;
  children: ReactNode;
}

export function PageShell({
  width = 'default',
  flush,
  className,
  children,
  ...props
}: PageShellProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-background" {...props}>
      <div
        className={cn(
          'container mx-auto px-3 sm:px-4',
          WIDTH_CLASS[width],
          !flush && 'py-6 sm:py-8',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
