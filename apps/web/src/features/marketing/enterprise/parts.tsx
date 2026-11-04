import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/*
 * The product frames /enterprise and /compliance share: a window with a title bar, and the
 * status mark a row carries. Rows wrap instead of scrolling, so each frame
 * stays readable at 390 px.
 */

export function Window({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('bg-background flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border', className)}>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span aria-hidden className="flex items-center gap-1.5">
          <span className="bg-muted-foreground/40 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/40 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/40 size-2.5 rounded-full" />
        </span>
        <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{title}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * A state mark. Hue only where it reports a state (color.md status table):
 * green for done, yellow for waiting, red for refused. The word carries the
 * meaning.
 */
export type Tone = 'ok' | 'wait' | 'no';

const TONE: Record<Tone, { dot: string; tint: string }> = {
  ok: { dot: 'bg-kortix-green', tint: 'bg-kortix-green/15' },
  wait: { dot: 'bg-kortix-yellow', tint: 'bg-kortix-yellow/15' },
  no: { dot: 'bg-kortix-red', tint: 'bg-kortix-red/15' },
};

export function Status({ tone = 'ok', children }: { tone?: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-medium',
        t.tint,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', t.dot)} />
      {children}
    </span>
  );
}
