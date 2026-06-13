'use client';

import {
  KORTIX_CMD_CLASS,
  KORTIX_CMD_STYLE,
  LineView,
  type Line,
} from '@/components/home/interactive-demo/cli/terminal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import { useEffect, useRef, type HTMLAttributes } from 'react';

export type StepCliBlock = { cmd: Line; out: Line[] };

export type StepCliMenuState = { selected: number; chosen: number | null };

export type RuntimeOption = { id: string; label: string; hint: string };

export const RUNTIMES: RuntimeOption[] = [
  { id: 'opencode', label: 'OpenCode', hint: 'open-source · default' },
  { id: 'claude-code', label: 'Claude Code', hint: 'Anthropic' },
  { id: 'codex', label: 'Codex', hint: 'OpenAI' },
  { id: 'cursor', label: 'Cursor', hint: 'Cursor CLI' },
];

export type StepCliDirector = {
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  menu?: StepCliMenuState | null;
};

export function StepCliTerminal({
  director,
  dragHandleProps,
}: {
  director: StepCliDirector;
  dragHandleProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const { scrollback, typed, running, menu } = director;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollback, typed, menu]);

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

        {menu && (
          <div className="space-y-0.5">
            <div className="wrap-break-word whitespace-pre-wrap">
              <span className="text-emerald-500">?</span>
              <span className="text-foreground"> Choose a coding runtime </span>
              <span className="text-muted-foreground/45">(↑/↓)</span>
            </div>
            {RUNTIMES.map((opt, i) => {
              const active = i === menu.selected;
              const chosen = menu.chosen === i;
              return (
                <div
                  key={opt.id}
                  className={cn(
                    'flex items-center gap-1.5',
                    active ? 'text-foreground' : 'text-muted-foreground/55',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn('w-2 shrink-0', active ? KORTIX_CMD_CLASS : 'opacity-0')}
                    style={active ? KORTIX_CMD_STYLE : undefined}
                  >
                    ❯
                  </span>
                  <span
                    className={active ? KORTIX_CMD_CLASS : undefined}
                    style={active ? KORTIX_CMD_STYLE : undefined}
                  >
                    {opt.label}
                  </span>
                  <span className="text-muted-foreground/40">· {opt.hint}</span>
                  {chosen && <span className="ml-auto text-emerald-500">✓</span>}
                </div>
              );
            })}
          </div>
        )}

        {running && !menu && (
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
