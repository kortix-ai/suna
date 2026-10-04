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
  actions,
  className,
  children,
}: {
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  // No actions means an empty bar — render the content alone. The file name
  // never gets a row of its own: the show card's header icon carries it as a
  // hover hint, so a name-only strip would be dead height.
  if (!actions) return <>{children}</>;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="bg-secondary flex min-h-12 shrink-0 flex-wrap items-center justify-end gap-2 border-b px-3 py-2">
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
