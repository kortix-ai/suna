import type { Command } from '@kortix/sdk/react';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';

import { insertCommandChip } from '../editor/mention-node';
import { baseSuggestion } from '../editor/suggestion';
import type { MenuController } from '../editor/suggestion';
import { mountDockedMenu, mountSuggestionMenu } from './mount';
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
  /**
   * CSS selector for the element the menu docks into. Omitted → the menu
   * floats at the caret, `document.body`-portalled, same as `@`. See
   * `mount.ts`'s `mountDockedMenu` for why `/` docks and `@` does not.
   */
  dockSelector?: string;
  /**
   * A real OpenCode command was picked. Notification only — the chip has
   * ALREADY been inserted into the document by `command()` below by the time
   * this fires, and the host does not need to do anything for the command to
   * survive. It exists so a host can react (analytics, hints); it is
   * deliberately no longer the mechanism by which the command is remembered.
   *
   * It used to be exactly that: the host stored the picked `Command` in React
   * state (`composer.tsx`'s `stagedCommand`) and rendered a banner for it. The
   * document knew nothing about it, so the host had to defend the banner by
   * feeding this menu an EMPTY command list for as long as one was staged —
   * which is why `/` appeared to stop working entirely after the first pick.
   * The chip removes the need for any of that.
   */
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

  /**
   * The pointer is the selection too. Hovering a row moves the SAME index the
   * arrow keys move, so the highlight, the detail pane, and what Enter runs
   * are always the one row under the cursor.
   *
   * Stable reference, same reason as `onSelect` above. The `setSelectedIndex`
   * return value is the render guard — `pointermove` fires continuously while
   * the mouse travels within one row, and only the first of those events
   * changes anything. See `MenuNavState.setSelectedIndex`.
   */
  const onHover = (row: SlashRow) => {
    if (nav.setSelectedIndex(row.index)) {
      renderer?.updateProps({ selectedIndex: nav.getSelectedIndex() });
    }
  };

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
        props: { sections, selectedIndex: nav.getSelectedIndex(), onSelect, onHover },
      });
      unmount = opts.dockSelector
        ? mountDockedMenu(props, renderer.element)
        : mountSuggestionMenu(props, renderer.element);
    },
    onUpdate(props) {
      // Reset-on-query-change first; `recompute` -> `nav.setRows` below only
      // ever clamps. See `MenuNavState.setQuery`'s doc comment.
      nav.setQuery(props.query);
      const sections = recompute(props.query);
      latestCommand = props.command;
      renderer?.updateProps({ sections, selectedIndex: nav.getSelectedIndex(), onSelect, onHover });
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
    ...baseSuggestion('/', SLASH_PLUGIN_KEY, controller, opts.dockSelector),
    /**
     * The hint that trails a bare `/` — "/Type to search".
     *
     * The suggestion plugin already wraps the trigger range in a decoration
     * span and tags it `is-empty` while the query has no characters; it also
     * copies `decorationContent` onto the span as `data-decoration-content`.
     * All that is missing is a rule to paint it, which lives in `globals.css`
     * beside the composer's own placeholder rule (same `content:
     * attr(...)`/`pointer-events: none` shape, for the same reason: it must
     * not be selectable and must not shift the caret).
     *
     * Rendering it this way rather than through the editor's placeholder
     * matters — the placeholder only exists on an EMPTY document, and by the
     * time a `/` has been typed the document is not empty. This decoration is
     * scoped to the trigger itself, so it also works for a `/` typed at the
     * end of a sentence, not just at the start of an empty draft.
     *
     * `@` gets no equivalent: its menu opens beside the caret with the row
     * list already visible, so the hint would restate what is on screen.
     */
    decorationClass: 'kortix-slash-trigger',
    decorationContent: 'Type to search',
    /**
     * A command row inserts a chip AT THE TRIGGER — the same shape
     * `mention-controller.ts` uses for `@`, deliberately: `deleteRange(range)`
     * removes the `/query` the user typed and the chip takes its place, so the
     * document reads as one continuous line the user wrote. The rest of the
     * paragraph is the command's arguments (`serialize.ts`'s `commandName` /
     * `text` split), and nothing about the composer enters a special mode.
     *
     * An action row inserts nothing: actions operate the composer (switch
     * model, attach a file) rather than being part of the message, so the
     * trigger text is deleted and the host is handed the action.
     */
    command: ({ editor, range, props: row }) => {
      editor.chain().focus().deleteRange(range).run();
      if (row.type === 'command' && row.command) {
        // `row.name` is `command.name || ''` (slash-items.ts). A nameless
        // command cannot be re-resolved from the live list at submit time,
        // so inserting a chip for it would produce a chip that can never run.
        if (row.name) insertCommandChip(editor, row.name);
        opts.onSelectCommand?.(row.command);
      } else if (row.type === 'action' && row.action) {
        opts.onSelectAction?.(row.action);
      }
    },
  };
}
