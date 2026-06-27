'use client';

/**
 * Shared diff rendering used by both the Commits and Change-requests views: the
 * colored monospace unified-diff block (`DiffView`) and the +adds/-removes
 * summary chips (`DiffStat`).
 */

import { cn } from '@/lib/utils';

/** Render a unified-diff patch as a colored monospace block. */
export function DiffView({ patch }: { patch?: string | null }) {
  const text = (patch ?? '').toString();
  if (!text.trim()) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">No changes to show.</div>
    );
  }
  const lines = text.split('\n');
  return (
    <pre className="overflow-auto whitespace-pre rounded-md bg-muted/40 p-2 font-mono text-[0.7rem] leading-relaxed scrollbar-thin">
      {lines.map((line, i) => {
        const isMeta =
          line.startsWith('+++') ||
          line.startsWith('---') ||
          line.startsWith('diff ') ||
          line.startsWith('index ');
        const isHunk = line.startsWith('@@');
        const isAdd = !isMeta && line.startsWith('+');
        const isRemove = !isMeta && line.startsWith('-');
        return (
          <div
            key={i}
            className={cn(
              'px-1',
              isHunk && 'text-brand',
              isMeta && 'text-muted-foreground',
              isAdd && 'bg-emerald-500/10 text-emerald-500',
              isRemove && 'bg-destructive/10 text-destructive',
              !isHunk && !isMeta && !isAdd && !isRemove && 'text-foreground/80',
            )}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

/** +adds / -removes summary chips. */
export function DiffStat({ additions, deletions }: { additions?: number; deletions?: number }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[0.7rem]">
      <span className="text-emerald-500">+{additions ?? 0}</span>
      <span className="text-destructive">-{deletions ?? 0}</span>
    </span>
  );
}
