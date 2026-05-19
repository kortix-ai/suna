'use client';

import { cn } from '@/lib/utils';
import { DiffView } from '@/components/diff/diff-view';

interface DiffRendererProps {
  patch: string;
  /** Optional. Older call sites pass it but Pierre derives the language from
   *  the patch's `+++` header, so we don't actually need it. */
  filename?: string;
  className?: string;
}

/**
 * Unified diff renderer used by checkpoint dialogs. Thin wrapper over the
 * shared `DiffView` (which sits on top of `@pierre/diffs`'s `PatchDiff`).
 * `filename` is accepted for source-compat with older call sites; Pierre
 * derives the language from the patch's `+++` header so it's only needed for
 * fall-back display in the file-header (which we suppress here).
 */
export function DiffRenderer({ patch, className }: DiffRendererProps) {
  return (
    <DiffView
      patch={patch}
      layout="unified"
      hideFileHeader
      className={cn('bg-background', className)}
    />
  );
}
