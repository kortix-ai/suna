'use client';

import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';
import { useEffect, useRef, type HTMLAttributes } from 'react';
import { KORTIX_CMD_CLASS, KORTIX_CMD_STYLE, LineView } from './terminal';
import type { DemoDirector } from './use-demo-director';

/* The floating CLI overlay. A non-interactive terminal that renders the
 * director's scrollback + the command being typed — the "remote control" that
 * visibly drives the web app behind it. */
export function CliTerminal({
  director,
  dragHandleProps,
}: {
  director: DemoDirector;
  dragHandleProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const { scrollback, typed, typingNote, running } = director;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pin to the latest line as output streams + the prompt types.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollback, typed]);

  return (
    <div className="bg-card border-border flex h-full w-full flex-col overflow-hidden rounded-md border">
      {/* chrome */}
      <div
        {...dragHandleProps}
        className={cn(
          'border-border/70 bg-muted/60 flex w-full shrink-0 items-center gap-2 border-b px-3 py-2',
          dragHandleProps?.className,
        )}
      >
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-red-400/80" />
          <span className="size-2.5 rounded-full bg-amber-400/80" />
          <span className="size-2.5 rounded-full bg-emerald-400/80" />
        </div>
        <span className="text-muted-foreground/70 ml-1.5 inline-flex items-center gap-1 text-[11px] font-medium">
          <KortixAsterisk index={0} parentClass="mt-0" />
          kortix cli
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span
            className={
              running
                ? 'mt-0.5 size-2 animate-pulse rounded-full bg-emerald-500'
                : 'bg-muted-foreground/30 size-2 rounded-full'
            }
          />
          <span className="text-muted-foreground/50 text-xs tracking-wide">
            {running ? 'live' : 'idle'}
          </span>
        </span>
      </div>

      {/* scrollback */}
      <div
        ref={scrollRef}
        className="text-foreground scrollbar-hide min-h-0 flex-1 space-y-2.5 overflow-auto mask-y-from-96% px-3.5 py-3 font-mono text-[11px] leading-relaxed"
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
            {!typingNote && <span className="text-muted-foreground/45">$ </span>}
            <span
              className={typingNote ? 'text-muted-foreground/45' : KORTIX_CMD_CLASS}
              style={typingNote ? undefined : KORTIX_CMD_STYLE}
            >
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
