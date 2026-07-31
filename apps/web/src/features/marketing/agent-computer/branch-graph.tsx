import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { parallel } from './content';

/** Centre of the 8px node dot, so the rail and every tick line up on one pixel. */
const RAIL = 'left-[3.5px]';

function Node() {
  return <span aria-hidden className="bg-foreground size-2 shrink-0 rounded-full" />;
}

function RailLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-foreground font-mono text-[11px] tracking-widest uppercase">
      {children}
    </span>
  );
}

/**
 * The shape of the whole product, drawn once: `main` at the top, one branch per
 * session hanging off it, and the single way back — a change request a person
 * merges. Built from divs and mono type rather than an image, so it stays sharp,
 * themes correctly, and can be read by a screen reader as the list it is.
 */
export function BranchGraph(): ReactNode {
  return (
    <div className="border-border bg-card rounded-sm border p-6 sm:p-10">
      {/* main, before any session exists */}
      <div className="flex items-center gap-3">
        <Node />
        <RailLabel>{parallel.base}</RailLabel>
        <span aria-hidden className="bg-border h-px flex-1" />
      </div>

      {/* one branch per session, ticking off main */}
      <div className="relative pt-1 pl-8 sm:pl-10">
        <span aria-hidden className={cn('bg-border absolute top-0 bottom-0 w-px', RAIL)} />
        <ul>
          {parallel.branches.map((branch) => (
            <li key={branch.id} className="relative">
              <span
                aria-hidden
                className={cn('bg-border absolute top-1/2 h-px w-5 sm:w-7', RAIL)}
              />
              <div className="flex flex-col gap-1.5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="text-muted-foreground/60 shrink-0 font-mono text-xs">
                    {branch.id}…
                  </span>
                  <span className="text-foreground truncate text-sm">{branch.label}</span>
                </span>
                <span className="border-border text-muted-foreground w-fit shrink-0 rounded-sm border px-2 py-1 font-mono text-[10px] tracking-widest uppercase">
                  {branch.state}
                </span>
              </div>
            </li>
          ))}
          <li className="relative">
            <span aria-hidden className={cn('bg-border absolute top-1/2 h-px w-5 sm:w-7', RAIL)} />
            <p className="text-muted-foreground/60 py-3.5 font-mono text-xs">{parallel.more}</p>
          </li>
        </ul>
      </div>

      {/* the one way back: an approved change request */}
      <div className="relative pl-8 sm:pl-10">
        <span aria-hidden className={cn('bg-border absolute top-0 h-1/2 w-px', RAIL)} />
        <span aria-hidden className={cn('bg-border absolute top-1/2 h-px w-5 sm:w-7', RAIL)} />
        <div className="flex flex-wrap items-center gap-3 py-3.5">
          <span className="border-border bg-background text-foreground rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase">
            {parallel.returnLabel}
          </span>
          <span className="text-muted-foreground/60 hidden font-mono text-xs sm:inline">
            {parallel.returnNote}
          </span>
          <span aria-hidden className="bg-border h-px min-w-6 flex-1" />
          <RailLabel>{parallel.base}</RailLabel>
          <Node />
        </div>
      </div>

      <p className="text-muted-foreground border-border mt-4 border-t pt-6 text-sm leading-relaxed">
        {parallel.footnote}
      </p>
    </div>
  );
}
