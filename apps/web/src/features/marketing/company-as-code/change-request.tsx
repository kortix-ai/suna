import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { change } from './content';

/* dosco is monochrome, so this diff cannot lean on the red/green every diff
   viewer uses. It separates the three line kinds the way print does instead:
   an added line is at full contrast with a solid rule down its left edge, a
   removed line is dimmed onto a filled band, and context sits between them. */
const ROW: Record<string, string> = {
  ctx: 'border-transparent text-muted-foreground/70',
  del: 'border-transparent bg-muted/60 text-muted-foreground/45',
  add: 'border-foreground/30 bg-foreground/[0.045] text-foreground',
};

const SIGN: Record<string, string> = { ctx: ' ', del: '-', add: '+' };

/**
 * One change request, drawn as the reviewer sees it: a title, the branch it
 * came from, the diff, and the line that says a person approved it.
 *
 * The diff is a change to a *skill* on purpose. The claim the section makes is
 * that the company's know-how is versioned exactly like its code, and the only
 * way to show that is to show the company's know-how in a diff.
 */
export function ChangeRequest(): ReactNode {
  const { cr } = change;

  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      {/* who opened it, and against what */}
      <div className="border-border flex flex-col gap-4 border-b p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-3">
          <span className="border-border text-muted-foreground rounded-sm border px-2 py-1 font-mono text-[10px] tracking-widest uppercase">
            {cr.badge}
          </span>
          <span className="text-muted-foreground/60 font-mono text-xs">{cr.branch}</span>
          <span className="text-muted-foreground/60 font-mono text-xs">·</span>
          <span className="text-muted-foreground/60 font-mono text-xs">{cr.author}</span>
        </div>
        <h3 className="text-foreground text-base leading-snug font-medium sm:text-lg">
          {cr.title}
        </h3>
      </div>

      {/* the file, then the diff */}
      <div className="border-border bg-background flex items-center justify-between gap-4 border-b px-5 py-2.5">
        <span className="text-muted-foreground overflow-x-auto font-mono text-[11px] whitespace-pre">
          {cr.file}
        </span>
        <span className="text-muted-foreground/60 shrink-0 font-mono text-[11px] tabular-nums">
          {cr.stat}
        </span>
      </div>

      <div className="bg-background overflow-x-auto">
        <pre className="font-mono text-[12.5px] leading-[1.9]">
          <code className="block min-w-max">
            {cr.diff.map((line, i) => (
              // Fixed, ordered diff: the index is the identity of the line.
              <span
                key={`diff-${i}`}
                className={cn('flex border-l-2 pr-5 whitespace-pre', ROW[line.kind])}
              >
                <span aria-hidden className="w-8 shrink-0 pl-4 opacity-60 select-none">
                  {SIGN[line.kind]}
                </span>
                <span>{line.text === '' ? ' ' : line.text}</span>
              </span>
            ))}
          </code>
        </pre>
      </div>

      {/* the gate */}
      <div className="border-border flex items-center gap-3 border-t px-5 py-4">
        <span aria-hidden className="bg-foreground size-1.5 shrink-0 rounded-full" />
        <span className="text-foreground font-mono text-[10px] tracking-widest uppercase">
          {cr.footer}
        </span>
      </div>
    </div>
  );
}
