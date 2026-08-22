'use client';

import { getFileIcon } from '@/features/project-files';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import type { Agent, Session } from '@kortix/sdk/react';
import { ChatIcon, FolderIcon } from '@phosphor-icons/react';
import { useEffect, useMemo } from 'react';

import { useFileSearch } from '../hooks/use-file-search';
import { MenuCard, MenuRow as MenuRowButton, MenuSectionHeading } from './menu-shell';
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
  onHover,
}: {
  sections: MentionSection[];
  selectedIndex: number;
  loading: boolean;
  onSelect: (row: MenuRow) => void;
  /** Hovering a row makes it the selection — see `MenuRow`'s own comment for
   *  why that is `pointermove` and not `pointerenter`. Keeps this menu's one
   *  highlight honest: what you point at is what Enter takes. */
  onHover?: (row: MenuRow) => void;
}) {
  // A query that matches nothing keeps the card, with one dead row saying so.
  // Returning `null` made the menu DISAPPEAR mid-word — indistinguishable from
  // the menu having closed, and one backspace brought it back from nowhere.
  if (!sections.length && !loading) {
    return (
      <MenuCard className="w-[min(26rem,calc(100vw-1.5rem))] rounded-lg">
        <p role="status" className="text-muted-foreground px-3 py-2.5 text-sm">
          No matches
        </p>
      </MenuCard>
    );
  }

  return (
    // `rounded-lg` (8px) — the cap `menu-shell.tsx` documents for app
    // containers, and the same radius the `/` palette uses, so the two menus
    // read as one system. It was `rounded-md` on the card AND on the rows,
    // which is the same radius on parent and child: the rows' corners visibly
    // cut inside the card's at the four extremes.
    <MenuCard className="w-[min(26rem,calc(100vw-1.5rem))] rounded-lg">
      <div
        role="listbox"
        aria-label="Mention suggestions"
        aria-activedescendant={`mention-row-${selectedIndex}`}
        // Focusable for AT, but not a tab stop — keyboard interaction stays in
        // the composer textarea, which proxies arrow/Enter to this listbox.
        tabIndex={-1}
        className="max-h-[19rem] overflow-y-auto p-1.5"
      >
        {sections.map((section) => (
          <div key={section.kind}>
            <MenuSectionHeading>{section.heading}</MenuSectionHeading>
            {section.items.map((row) => (
              <MenuRowButton
                key={`${row.kind}-${row.value}-${row.index}`}
                id={`mention-row-${row.index}`}
                selected={row.index === selectedIndex}
                onSelect={() => onSelect(row)}
                onHover={() => onHover?.(row)}
              >
                <RowIcon row={row} />
                <span className="min-w-0 truncate text-sm">{rowTitle(row)}</span>
                {row.description && (
                  <span className="text-muted-foreground ml-auto shrink-0 truncate text-xs">
                    {row.description}
                  </span>
                )}
              </MenuRowButton>
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
    </MenuCard>
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
  onHover?: (row: MenuRow) => void;
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
  onHover,
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

  return (
    <MentionMenu
      sections={sections}
      selectedIndex={selectedIndex}
      loading={isLoading}
      onSelect={onSelect}
      onHover={onHover}
    />
  );
}
