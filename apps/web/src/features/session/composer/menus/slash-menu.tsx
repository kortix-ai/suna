'use client';

import { cn } from '@/lib/utils';
import type { Command } from '@kortix/sdk/react';
import { ReactRenderer } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import type { SuggestionOptions } from '@tiptap/suggestion';

import type { MenuController } from '../editor/suggestion';
import { baseSuggestion } from '../editor/suggestion';
import type { SlashAction } from './slash-actions';
import { buildSlashSections } from './slash-items';
import type { SlashRow, SlashSection } from './slash-items';
import { clampSelection, moveSelection } from './menu-selection';

export const SLASH_PLUGIN_KEY = new PluginKey('slashSuggestion');

/**
 * Purely presentational, same as `MentionMenu`. Unlike the `@` menu there is
 * no async data source here (commands + actions are both already resolved by
 * the time `createSlashSuggestion` builds a row list), so there is no
 * "Host" wrapper component — the controller below computes `sections`
 * directly and hands them down as a prop.
 */
export function SlashMenu({
  sections,
  selectedIndex,
  onSelect,
}: {
  sections: SlashSection[];
  selectedIndex: number;
  onSelect: (row: SlashRow) => void;
}) {
  if (!sections.length) return null;

  return (
    <div
      role="listbox"
      aria-label="Commands and actions"
      aria-activedescendant={`slash-row-${selectedIndex}`}
      className="bg-popover border-border w-[min(28rem,90vw)] overflow-hidden rounded-xl border shadow-md"
    >
      <div className="max-h-80 overflow-y-auto p-1">
        {sections.map((section) => (
          <div key={section.heading}>
            <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
              {section.heading}
            </div>
            {section.rows.map((row) => (
              <button
                key={`${row.type}-${row.name}-${row.index}`}
                id={`slash-row-${row.index}`}
                role="option"
                aria-selected={row.index === selectedIndex}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(row);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left',
                  row.index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {row.type === 'command' ? `/${row.name}` : row.name}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">{row.description}</p>
                </div>
                {row.hint && (
                  <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-sans text-xs">
                    {row.hint}
                  </kbd>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface CreateSlashSuggestionOptions {
  getCommands: () => Command[];
  /** A real OpenCode command was picked. This STAGES it — mirrors the live
   *  `handleSelectCommand` (session-chat-input.tsx:875-883): the host shows
   *  an args input and waits for a submit, it does not run the command here. */
  onSelectCommand?: (command: Command) => void;
  /** A composer action was picked (switch-model, set-scope, ...). The host
   *  owns what each action id opens or does — this callback is the only
   *  handoff point. */
  onSelectAction?: (action: SlashAction) => void;
  /** Toggled true on open, false on exit — see composer-editor.tsx's
   *  `suggestionActiveRef`. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Builds the `/` slash Suggestion options. Registered through
 * `createSuggestionExtension` in composer-editor.tsx, exactly like the `@`
 * mention menu — the "one `@tiptap/suggestion` code path" both triggers run
 * through.
 */
export function createSlashSuggestion(
  opts: CreateSlashSuggestionOptions,
): Omit<SuggestionOptions<never, SlashRow>, 'editor'> {
  let renderer: ReactRenderer | null = null;
  let unmount: (() => void) | null = null;
  let selectedIndex = 0;
  let rows: SlashRow[] = [];
  let latestCommand: ((row: SlashRow) => void) | null = null;

  const recompute = (query: string): SlashSection[] =>
    buildSlashSections({ commands: opts.getCommands(), query });

  const controller: MenuController<SlashRow> = {
    onStart(props) {
      const sections = recompute(props.query);
      rows = sections.flatMap((s) => s.rows);
      selectedIndex = 0;
      latestCommand = props.command;
      opts.onActiveChange?.(true);
      renderer = new ReactRenderer(SlashMenu, {
        editor: props.editor,
        props: { sections, selectedIndex, onSelect: (row: SlashRow) => props.command(row) },
      });
      unmount = props.mount(renderer.element);
    },
    onUpdate(props) {
      const sections = recompute(props.query);
      rows = sections.flatMap((s) => s.rows);
      selectedIndex = clampSelection(selectedIndex, rows.length);
      latestCommand = props.command;
      renderer?.updateProps({
        sections,
        selectedIndex,
        onSelect: (row: SlashRow) => props.command(row),
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
    ...baseSuggestion('/', SLASH_PLUGIN_KEY, controller),
    command: ({ editor, range, props: row }) => {
      editor.chain().focus().deleteRange(range).run();
      if (row.type === 'command' && row.command) opts.onSelectCommand?.(row.command);
      else if (row.type === 'action' && row.action) opts.onSelectAction?.(row.action);
    },
  };
}
