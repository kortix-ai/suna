'use client';

import {
  KORTIX_CMD_CLASS,
  KORTIX_CMD_STYLE,
  LineView,
  type Line,
} from '@/components/home/interactive-demo/cli/terminal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

export type StepCliBlock = { cmd: Line; out: Line[] };

export type StepCliDirector = {
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
};

/** The floating terminal window: scrollback, then the line being typed. */
export function StepCliTerminal({
  director,
  dragHandleProps,
}: {
  director: StepCliDirector;
  dragHandleProps?: HTMLAttributes<HTMLDivElement>;
}): ReactNode {
  const { scrollback, typed, running } = director;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollback, typed]);

  return (
    <div className="bg-background border-border flex h-full w-full flex-col overflow-hidden rounded-md border">
      <div
        {...dragHandleProps}
        className={cn(
          'border-border/70 bg-background flex w-full shrink-0 items-center gap-2 border-b px-3 py-2',
          dragHandleProps?.className,
        )}
      >
        <span className="text-muted-foreground ml-1.5 inline-flex items-center gap-1 text-[11px] font-medium">
          <KortixLogo size={12} />
          Kortix
        </span>
      </div>

      <div
        ref={scrollRef}
        // `overflow-hidden`, not `auto`: the wheel must never be captured by a
        // panel inside the pinned section. The effect above still scrolls this
        // box programmatically as the movie types — a hidden overflow box is
        // still scrollable from script, just not by the reader.
        className="text-foreground min-h-0 flex-1 space-y-2.5 overflow-hidden mask-y-from-96% px-3.5 py-3 font-mono text-[11px] leading-relaxed"
      >
        {scrollback.map((block, i) => (
          <div key={i} className="space-y-0.5">
            <LineView line={block.cmd} />
            {block.out.map((line, j) => (
              <LineView key={j} line={line} />
            ))}
          </div>
        ))}

        {running && (
          <div className="flex items-center whitespace-pre">
            <span className="text-muted-foreground/45">$ </span>
            <span className={KORTIX_CMD_CLASS} style={KORTIX_CMD_STYLE}>
              {typed}
            </span>
            <span
              aria-hidden
              className="bg-foreground/70 ml-px inline-block h-[1.05em] w-[0.5em] translate-y-[0.12em] animate-pulse"
            />
          </div>
        )}
      </div>
    </div>
  );
}
