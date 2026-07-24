'use client';

/**
 * `ViewerFrame` — the header row for renderers that don't ship one.
 *
 * PDF, DOCX and XLSX each own a real toolbar (thumbnails, zoom, search, a file
 * menu) and take extra controls through their own `toolbarActions` slot. CSV,
 * PPTX and the plain-text/code viewer have no toolbar at all, so actions had
 * nowhere to live and those types silently went without.
 *
 * This supplies the missing row for exactly those renderers, deliberately
 * matching the chrome the real toolbars use — `min-h-12`, `border-b`,
 * `bg-background`, `px-3 py-2` — so a CSV header and a PDF header are the same
 * object to the eye. It is NOT a second header stacked on a viewer that
 * already has one; callers pass actions through the native slot where a native
 * slot exists, and reach for this only where none does.
 */

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function ViewerFrame({
  /** Shown at the left. The file's own name — never a path, which would
   *  truncate to something unreadable in a narrow card. */
  label,
  actions,
  className,
  children,
}: {
  label?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  // No actions and no name means an empty bar — render the content alone
  // rather than a decorative strip carrying nothing.
  if (!actions && !label) return <>{children}</>;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="bg-background flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-foreground/80 min-w-0 flex-1 truncate text-xs font-medium">
          {label}
        </span>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
