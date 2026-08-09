import type { Command } from '@kortix/sdk/react';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';

import { baseSuggestion } from '../editor/suggestion';
import type { MenuController } from '../editor/suggestion';
import { SlashMenu } from './slash-menu';
import type { SlashAction } from './slash-actions';
import { buildSlashSections } from './slash-items';
import type { SlashRow, SlashSection } from './slash-items';
import { MenuNavState } from './menu-nav-state';

export const SLASH_PLUGIN_KEY = new PluginKey('slashSuggestion');

export interface CreateSlashSuggestionOptions {
  getCommands: () => Command[];
  /**
   * Live source for the `/` menu's Actions section — defaults to
   * `SLASH_ACTIONS` (`slash-items.ts`'s own default) when omitted, so
   * existing callers that don't pass this see no change. `composer.tsx`
   * (Task 13) passes `[]` while a command is staged, so selecting a Commands
   * row can't discard the args being typed.
   */
  getActions?: () => SlashAction[];
  /** A real OpenCode command was picked. This STAGES it — mirrors the live
   *  `handleSelectCommand` (session-chat-input.tsx:875-883): the host shows
   *  an args input and waits for a submit, it does not run the command here. */
  onSelectCommand?: (command: Command) => void;
  /** A composer action was picked (switch-model, set-scope, ...). The host
   *  owns what each action id opens or does — this callback is the only
   *  handoff point. */
  onSelectAction?: (action: SlashAction) => void;
  /**
   * Fires ONLY on the false<->true boundary of "does at least one row exist
   * right now" — NOT "is a trigger match active". See `MenuNavState`'s own
   * doc comment: a `/xyzzy` match with zero rows must leave this `false` the
   * whole time it's open, or Enter stops doing anything (no submit, no
   * selection) instead of falling through to submit like the live composer
   * does.
   */
  onHasRowsChange?: (hasRows: boolean) => void;
  /**
   * Fires on the false<->true boundary of "is the `/` menu open at all" --
   * see `MenuNavState`'s own `onOpenChange` doc comment. Task 9's seam for
   * `useMenuRevalidation` (`../hooks/use-file-search.ts`): the composer
   * shell ORs this with `mention-controller.ts`'s equivalent and revalidates
   * the agents/commands caches the instant either menu opens, so a skill,
   * agent, or command created after page load shows up without a reload.
   */
  onOpenChange?: (isOpen: boolean) => void;
}

/**
 * Builds the `/` slash Suggestion options. Registered through
 * `createSuggestionExtension` in composer-editor.tsx, exactly like the `@`
 * mention menu — the "one `@tiptap/suggestion` code path" both triggers run
 * through.
 *
 * All keyboard/index/row bookkeeping is delegated to `MenuNavState`
 * (`menu-nav-state.ts`) — this module only owns the parts that genuinely
 * need `ReactRenderer`/DOM/the editor.
 */
export function createSlashSuggestion(
  opts: CreateSlashSuggestionOptions,
): Omit<SuggestionOptions<never, SlashRow>, 'editor'> {
  let renderer: ReactRenderer | null = null;
  let unmount: (() => void) | null = null;
  let latestCommand: ((row: SlashRow) => void) | null = null;

  const nav = new MenuNavState<SlashRow>({
    onHasRowsChange: opts.onHasRowsChange,
    onOpenChange: opts.onOpenChange,
  });

  // Same stabilization as `mention-controller.ts`'s `onSelect` — a fixed
  // reference so `updateProps`'s shallow diff isn't forced to treat every
  // keystroke as "changed" purely because the plugin handed us a fresh
  // `command` closure.
  const onSelect = (row: SlashRow) => latestCommand?.(row);

  const recompute = (query: string): SlashSection[] => {
    const sections = buildSlashSections({
      commands: opts.getCommands(),
      actions: opts.getActions?.(),
      query,
    });
    nav.setRows(sections.flatMap((s) => s.rows));
    return sections;
  };

  const controller: MenuController<SlashRow> = {
    onStart(props) {
      nav.open(props.query);
      const sections = recompute(props.query);
      latestCommand = props.command;
      renderer = new ReactRenderer(SlashMenu, {
        editor: props.editor,
        props: { sections, selectedIndex: nav.getSelectedIndex(), onSelect },
      });
      unmount = props.mount(renderer.element);
    },
    onUpdate(props) {
      // Reset-on-query-change first; `recompute` -> `nav.setRows` below only
      // ever clamps. See `MenuNavState.setQuery`'s doc comment.
      nav.setQuery(props.query);
      const sections = recompute(props.query);
      latestCommand = props.command;
      renderer?.updateProps({ sections, selectedIndex: nav.getSelectedIndex(), onSelect });
    },
    onKeyDown({ event }) {
      if (!nav.getRows().length) return false;
      if (event.key === 'ArrowDown') {
        nav.move(1);
        renderer?.updateProps({ selectedIndex: nav.getSelectedIndex() });
        return true;
      }
      if (event.key === 'ArrowUp') {
        nav.move(-1);
        renderer?.updateProps({ selectedIndex: nav.getSelectedIndex() });
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const row = nav.getSelectedRow();
        if (row) latestCommand?.(row);
        return true;
      }
      return false;
    },
    onExit() {
      nav.close();
      unmount?.();
      renderer?.destroy();
      renderer = null;
      unmount = null;
      latestCommand = null;
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
