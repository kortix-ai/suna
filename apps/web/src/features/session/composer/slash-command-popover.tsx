'use client';

import { useEffect, useMemo, useRef } from 'react';

import { cn } from '@/lib/utils';
import type { Command } from '@kortix/sdk/react';

// ============================================================================
// Slash Command Popover — uses fixed positioning to escape overflow-hidden ancestors
// ============================================================================

export function SlashCommandPopover({
  commands,
  filter,
  selectedIndex,
  onSelect,
  anchorRef,
}: {
  commands: Command[];
  filter: string;
  selectedIndex: number;
  onSelect: (command: Command) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return commands.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q),
    );
  }, [commands, filter]);

  // Scroll selected item into view
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const item = container.children[selectedIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  // Read position synchronously from the anchor ref — fixed positioning
  // escapes overflow-hidden ancestors without needing a portal.
  const el = anchorRef.current;
  if (!el) return null;
  const r = el.getBoundingClientRect();

  return (
    <div
      className="bg-popover border-border/60 fixed z-[99999] overflow-hidden rounded-2xl border"
      style={{
        bottom: window.innerHeight - r.top + 4,
        left: r.left,
        width: Math.min(r.width, 480),
      }}
    >
      <div ref={scrollRef} className="max-h-64 overflow-y-auto py-1">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.name}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd);
            }}
            className={cn(
              '-mx-1 flex w-full cursor-pointer flex-col gap-0.5 rounded-2xl border border-transparent px-3 py-2 text-left transition-colors',
              i === selectedIndex ? 'bg-muted border-border/50' : 'hover:bg-muted/50',
            )}
          >
            <span className="text-foreground font-mono text-sm">/{cmd.name}</span>
            {cmd.description && (
              <span className="text-muted-foreground/40 line-clamp-2 text-xs">
                {cmd.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
