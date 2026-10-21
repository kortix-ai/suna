import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/**
 * The one section shell this page uses. Every section is the same width and
 * the same rhythm, so the page reads as one document rather than a stack of
 * blocks. Headings come from `component/section-header`.
 */
/** Section shell. Same vertical rhythm as `/channels` and `/connectors`. */
export function Section({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('mx-auto max-w-7xl px-6 py-24 sm:py-30', className)}>
      {children}
    </section>
  );
}

/** A mono uppercase micro-label. The only small-caps voice on these pages. */
/** A mono uppercase label. Used for the small in-diagram headings. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground font-mono text-[10px] tracking-widest uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
}
