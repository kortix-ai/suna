'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArrowUp, Slash, Square } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

type Command = { name: string; description: string | null };

/**
 * Chat composer as a self-contained input card. Enter sends, Shift+Enter
 * newlines. Typing "/" opens a project-command menu (server-side `commands`);
 * picking + sending a "/cmd args" line runs it via `onCommand` instead of
 * sending a text prompt. While the agent is busy the send button stops the run.
 */
export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  placeholder = 'Message the agent…',
  toolbar,
  commands,
  onCommand,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  toolbar?: ReactNode;
  commands?: Command[];
  onCommand?: (name: string, args: string) => void;
}) {
  const [value, setValue] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // The command menu shows only while typing a bare "/token" (no space yet).
  const slashQuery = useMemo(() => {
    const m = value.match(/^\/(\S*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [value]);
  const matches = useMemo(() => {
    if (slashQuery === null || !commands?.length || !onCommand) return [];
    return commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8);
  }, [slashQuery, commands, onCommand]);
  const menuOpen = matches.length > 0 && !dismissed;

  useEffect(() => setHighlight(0), [slashQuery]);

  const setText = (next: string) => {
    setValue(next);
    setDismissed(false);
    requestAnimationFrame(grow);
  };

  const pickCommand = (name: string) => {
    setText(`/${name} `);
    ref.current?.focus();
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (m && onCommand && commands?.some((c) => c.name === m[1])) {
      onCommand(m[1], (m[2] ?? '').trim());
    } else {
      onSend(text);
    }
    setValue('');
    requestAnimationFrame(grow);
  };

  return (
    <div className="relative">
      {menuOpen && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            Commands
          </div>
          <div className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
            {matches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pickCommand(c.name)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
                  i === highlight ? 'bg-accent' : 'hover:bg-accent',
                )}
              >
                <Slash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">/{c.name}</div>
                  {c.description && (
                    <div className="truncate text-xs text-muted-foreground">{c.description}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={cn(
          'rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60',
          disabled && 'opacity-70',
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, matches.length - 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const sel = matches[highlight] ?? matches[0];
                if (sel) pickCommand(sel.name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              // Don't fire a new turn while the agent is busy — the visible
              // control is Stop; use it (the button) to cancel.
              if (!busy) submit();
            }
          }}
          className="max-h-52 min-h-[24px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground scrollbar-thin"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <div className="min-w-0">{toolbar}</div>
          {busy ? (
            <Button
              size="icon"
              variant="secondary"
              onClick={onStop}
              aria-label="Stop"
              className="size-8 rounded-full"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={!value.trim() || disabled}
              aria-label="Send"
              className="size-8 rounded-full"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
