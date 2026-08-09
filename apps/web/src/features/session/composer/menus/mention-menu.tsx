'use client';

import { getFileIcon } from '@/features/project-files';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import type { Agent, Session } from '@kortix/sdk/react';
import { ChatIcon, FolderIcon } from '@phosphor-icons/react';
import { useEffect, useMemo } from 'react';

import { useFileSearch } from '../hooks/use-file-search';
import { buildMentionSections } from './menu-items';
import type { MenuRow, MentionSection } from './menu-items';

/**
 * Purely presentational — every prop is already the final thing to render.
 * `role="listbox"` / `aria-activedescendant` here, `role="option"` /
 * `aria-selected` per row: this is the accessibility neither
 * `mention-popover.tsx` nor `slash-command-popover.tsx` had.
 */
export function MentionMenu({
  sections,
  selectedIndex,
  loading,
  onSelect,
}: {
  sections: MentionSection[];
  selectedIndex: number;
  loading: boolean;
  onSelect: (row: MenuRow) => void;
}) {
  if (!sections.length && !loading) return null;

  return (
    <div
      role="listbox"
      aria-label="Mention suggestions"
      aria-activedescendant={`mention-row-${selectedIndex}`}
      className="bg-popover border-border w-[min(28rem,90vw)] overflow-hidden rounded-xl border shadow-md"
    >
      <div className="max-h-72 overflow-y-auto p-1">
        {sections.map((section) => (
          <div key={section.kind}>
            <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
              {section.heading}
            </div>
            {section.items.map((row) => (
              <button
                key={`${row.kind}-${row.value}-${row.index}`}
                id={`mention-row-${row.index}`}
                role="option"
                aria-selected={row.index === selectedIndex}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(row);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
                  row.index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
              >
                <RowIcon row={row} />
                <span className="truncate font-medium">{rowTitle(row)}</span>
                {row.description && (
                  <span className="text-muted-foreground ml-auto truncate text-xs">
                    {row.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {loading && (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-2 text-xs">
            <Loading className="size-3.5" />
            Searching…
          </div>
        )}
      </div>
    </div>
  );
}

function rowTitle(row: MenuRow): string {
  if (row.kind !== 'file') return row.label;
  const clean = row.label.endsWith('/') ? row.label.slice(0, -1) : row.label;
  return clean.split('/').pop() || clean;
}

function RowIcon({ row }: { row: MenuRow }) {
  if (row.kind === 'agent') {
    return (
      <span className="bg-foreground/10 text-foreground/60 flex size-4 shrink-0 items-center justify-center rounded text-xs font-semibold">
        @
      </span>
    );
  }
  if (row.kind === 'session') return <ChatIcon className="text-muted-foreground size-4 shrink-0" />;
  if (row.label.endsWith('/')) return <FolderIcon className="text-muted-foreground size-4 shrink-0" />;
  return getFileIcon(row.label, { className: 'size-4 shrink-0 text-muted-foreground' });
}

export interface MentionMenuHostProps {
  query: string;
  agents: Agent[];
  sessions: Session[];
  currentSessionId: string | undefined;
  /** Fixed at the moment the menu opened (`Date.now()`, computed in
   *  `mention-controller.ts`'s `onStart` — never inside this component's
   *  render, and never refreshed on every keystroke) so this prop's identity
   *  stays stable across a typing session instead of forcing a re-render on
   *  every `onUpdate` purely because a millisecond ticked over. */
  now: number;
  selectedIndex: number;
  onSelect: (row: MenuRow) => void;
  onRowsChange: (rows: MenuRow[]) => void;
}

/**
 * The stateful half `MentionMenu` above doesn't own: fetches files
 * (`useFileSearch`, debounced + cached — Task 6), combines them with the
 * synchronous agent/session lists via `buildMentionSections` (Task 6), and
 * reports its flat row list back to `MenuNavState` (via `onRowsChange`, wired
 * in `mention-controller.ts`) — which runs OUTSIDE React, from the
 * Suggestion plugin's own `handleKeyDown` — so keyboard nav knows how many
 * rows exist and what Enter/Tab should select. `selectedIndex` stays an
 * external prop; this component never owns it.
 */
export function MentionMenuHost({
  query,
  agents,
  sessions,
  currentSessionId,
  now,
  selectedIndex,
  onSelect,
  onRowsChange,
}: MentionMenuHostProps) {
  const { files, isLoading } = useFileSearch(query, true);
  const sections = useMemo(
    () => buildMentionSections({ agents, sessions, files, query, currentSessionId, now }),
    [agents, sessions, files, query, currentSessionId, now],
  );
  const rows = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => {
    onRowsChange(rows);
  }, [rows, onRowsChange]);

  return <MentionMenu sections={sections} selectedIndex={selectedIndex} loading={isLoading} onSelect={onSelect} />;
}
