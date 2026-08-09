'use client';

import { getFileIcon } from '@/features/project-files';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import type { Agent, Session } from '@kortix/sdk/react';
import { ChatIcon, FolderIcon } from '@phosphor-icons/react';
import { ReactRenderer } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import { useEffect, useMemo } from 'react';

import { insertMention } from '../editor/mention-node';
import { baseSuggestion } from '../editor/suggestion';
import type { MenuController } from '../editor/suggestion';
import { useFileSearch } from '../hooks/use-file-search';
import { buildMentionSections } from './menu-items';
import type { MenuRow, MentionSection } from './menu-items';
import { clampSelection, moveSelection } from './menu-selection';
import type { SuggestionOptions } from '@tiptap/suggestion';

export const MENTION_PLUGIN_KEY = new PluginKey('mentionSuggestion');

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

interface MentionMenuHostProps {
  query: string;
  agents: Agent[];
  sessions: Session[];
  currentSessionId: string | undefined;
  /** Supplied by the controller (`Date.now()` at open/keystroke time) — never
   *  read live inside this component, which would be an impure render read. */
  now: number;
  selectedIndex: number;
  onSelect: (row: MenuRow) => void;
  onRowsChange: (rows: MenuRow[]) => void;
}

/**
 * The stateful half `MentionMenu` above doesn't own: fetches files
 * (`useFileSearch`, debounced + cached — Task 6), combines them with the
 * synchronous agent/session lists via `buildMentionSections` (Task 6), and
 * reports its flat row list back to the controller (`createMentionSuggestion`
 * below) so keyboard nav — which runs OUTSIDE React, from the Suggestion
 * plugin's own `handleKeyDown` — knows how many rows exist and what Enter/Tab
 * should select. `selectedIndex` stays an external prop; this component never
 * owns it.
 */
function MentionMenuHost({
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

export interface CreateMentionSuggestionOptions {
  getAgents: () => Agent[];
  getSessions: () => Session[];
  getCurrentSessionId: () => string | undefined;
  /** Toggled true on open, false on exit — see composer-editor.tsx's
   *  `suggestionActiveRef`: it guards Enter-to-submit from firing while
   *  Enter is meant to accept a highlighted row instead. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Builds the `@` mention Suggestion options. Registered through
 * `createSuggestionExtension` in composer-editor.tsx — this function only
 * returns the options, it does not touch the editor directly.
 */
export function createMentionSuggestion(
  opts: CreateMentionSuggestionOptions,
): Omit<SuggestionOptions<never, MenuRow>, 'editor'> {
  let renderer: ReactRenderer | null = null;
  let unmount: (() => void) | null = null;
  let selectedIndex = 0;
  let rows: MenuRow[] = [];
  let latestCommand: ((row: MenuRow) => void) | null = null;

  const handleRowsChange = (nextRows: MenuRow[]) => {
    rows = nextRows;
    selectedIndex = clampSelection(selectedIndex, rows.length);
    renderer?.updateProps({ selectedIndex });
  };

  const controller: MenuController<MenuRow> = {
    onStart(props) {
      selectedIndex = 0;
      rows = [];
      latestCommand = props.command;
      opts.onActiveChange?.(true);
      renderer = new ReactRenderer(MentionMenuHost, {
        editor: props.editor,
        props: {
          query: props.query,
          agents: opts.getAgents(),
          sessions: opts.getSessions(),
          currentSessionId: opts.getCurrentSessionId(),
          now: Date.now(),
          selectedIndex,
          onSelect: (row: MenuRow) => props.command(row),
          onRowsChange: handleRowsChange,
        } satisfies MentionMenuHostProps,
      });
      unmount = props.mount(renderer.element);
    },
    onUpdate(props) {
      latestCommand = props.command;
      renderer?.updateProps({
        query: props.query,
        agents: opts.getAgents(),
        sessions: opts.getSessions(),
        currentSessionId: opts.getCurrentSessionId(),
        now: Date.now(),
        onSelect: (row: MenuRow) => props.command(row),
      });
    },
    onKeyDown({ event }) {
      if (!rows.length) return false;
      if (event.key === 'ArrowDown') {
        selectedIndex = moveSelection(selectedIndex, 1, rows.length);
        renderer?.updateProps({ selectedIndex });
        return true;
      }
      if (event.key === 'ArrowUp') {
        selectedIndex = moveSelection(selectedIndex, -1, rows.length);
        renderer?.updateProps({ selectedIndex });
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const row = rows[clampSelection(selectedIndex, rows.length)];
        if (row) latestCommand?.(row);
        return true;
      }
      return false;
    },
    onExit() {
      opts.onActiveChange?.(false);
      unmount?.();
      renderer?.destroy();
      renderer = null;
      unmount = null;
      latestCommand = null;
      rows = [];
    },
  };

  return {
    ...baseSuggestion('@', MENTION_PLUGIN_KEY, controller),
    command: ({ editor, range, props: row }) => {
      editor.chain().focus().deleteRange(range).run();
      insertMention(editor, { kind: row.kind, label: row.label, value: row.value });
    },
  };
}
