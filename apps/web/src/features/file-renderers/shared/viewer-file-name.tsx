'use client';

import { cn } from '@/lib/utils';

export function resolveViewerFileName(fileName: string | undefined, fallback: string): string {
  const base = fileName?.split('/').pop()?.trim();
  return base || fallback;
}

/**
 * File name slot for the document-viewer toolbars (left side, opposite the
 * zoom/search controls). Falls back to a format label ("PDF", "Word", …)
 * when the caller has no name for the document.
 */
export function ViewerFileName({
  fileName,
  fallback,
  className,
}: {
  fileName?: string;
  fallback: string;
  className?: string;
}) {
  const display = resolveViewerFileName(fileName, fallback);
  return (
    <span
      title={display}
      className={cn('min-w-0 max-w-60 truncate text-sm font-medium', className)}
    >
      {display}
    </span>
  );
}
