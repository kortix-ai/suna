import type { Agent, Session } from '@kortix/sdk/react';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';

import { insertMention } from '../editor/mention-node';
import { baseSuggestion } from '../editor/suggestion';
import type { MenuController } from '../editor/suggestion';
import { MentionMenuHost } from './mention-menu';
import { mountSuggestionMenu } from './mount';
import type { MentionMenuHostProps } from './mention-menu';
import type { MenuRow } from './menu-items';
import { MenuNavState } from './menu-nav-state';

export const MENTION_PLUGIN_KEY = new PluginKey('mentionSuggestion');

export interface CreateMentionSuggestionOptions {
  getAgents: () => Agent[];
  getSessions: () => Session[];
  getCurrentSessionId: () => string | undefined;
  /**
   * Fires ONLY on the false<->true boundary of "does at least one row exist
   * right now" — NOT "is a trigger match active". See `MenuNavState`'s own
   * doc comment: an `@nonexistentfile` match with zero rows must leave this
   * `false` the whole time it's open, or Enter stops doing anything (no
   * submit, no selection) instead of falling through to submit like the live
   * composer does.
   */
  onOwnsEnterChange?: (ownsEnter: boolean) => void;
  /**
   * Fires on the false<->true boundary of "is the `@` menu open at all" --
   * see `MenuNavState`'s own `onOpenChange` doc comment. Task 9's seam for
   * `useMenuRevalidation` (`../hooks/use-file-search.ts`): the composer
   * shell ORs this with `slash-controller.ts`'s equivalent and revalidates
   * the agents/commands caches the instant either menu opens, so a skill,
   * agent, or command created after page load shows up without a reload.
   */
  onOpenChange?: (isOpen: boolean) => void;
}

/**
 * Builds the `@` mention Suggestion options. Registered through
 * `createSuggestionExtension` in composer-editor.tsx — this function only
 * returns the options, it does not touch the editor directly.
 *
 * All keyboard/index/row bookkeeping is delegated to `MenuNavState`
 * (`menu-nav-state.ts`) — this module only owns the parts that genuinely
 * need `ReactRenderer`/DOM/the editor: mounting the popup, forwarding
 * `props.command` for a keyboard-driven selection, and the actual
 * delete-range-then-insert-mention side effect.
 */
export function createMentionSuggestion(
  opts: CreateMentionSuggestionOptions,
): Omit<SuggestionOptions<never, MenuRow>, 'editor'> {
  let renderer: ReactRenderer | null = null;
  let unmount: (() => void) | null = null;
  let latestCommand: ((row: MenuRow) => void) | null = null;

  const nav = new MenuNavState<MenuRow>({
    onOwnsEnterChange: opts.onOwnsEnterChange,
    onOpenChange: opts.onOpenChange,
  });

  // A STABLE reference — read `latestCommand` fresh at call time instead of
  // closing over `props.command` directly, so `updateProps`'s shallow prop
  // diff never sees `onSelect` as "changed" purely because the plugin handed
  // us a new `command` closure this keystroke (it always does — `command` is
  // rebuilt every transaction to capture the current `range`, see the
  // installed package's `plugin/view.ts`). Passing the SAME function
  // reference every time lets the shallow compare actually skip a re-render
  // when nothing else changed.
  const onSelect = (row: MenuRow) => latestCommand?.(row);

  /**
   * Hover moves the same index the arrow keys move, so this menu shows ONE
   * highlight and Enter always takes the row under the cursor. Stable
   * reference for the same shallow-diff reason as `onSelect`; the boolean
   * return is the re-render guard, since `pointermove` fires continuously
   * across a single row. See `MenuNavState.setSelectedIndex` and `MenuRow`.
   */
  const onHover = (row: MenuRow) => {
    if (nav.setSelectedIndex(row.index)) {
      renderer?.updateProps({ selectedIndex: nav.getSelectedIndex() });
    }
  };

  const handleRowsChange = (rows: MenuRow[]) => {
    nav.setRows(rows);
    renderer?.updateProps({ selectedIndex: nav.getSelectedIndex() });
  };

  const controller: MenuController<MenuRow> = {
    onStart(props) {
      nav.open(props.query);
      latestCommand = props.command;
      renderer = new ReactRenderer(MentionMenuHost, {
        editor: props.editor,
        props: {
          query: props.query,
          agents: opts.getAgents(),
          sessions: opts.getSessions(),
          currentSessionId: opts.getCurrentSessionId(),
          // Fixed for the lifetime of this open menu — see
          // `MentionMenuHostProps.now`'s own doc comment.
          now: Date.now(),
          selectedIndex: nav.getSelectedIndex(),
          onSelect,
          onHover,
          onRowsChange: handleRowsChange,
        } satisfies MentionMenuHostProps,
      });
      unmount = mountSuggestionMenu(props, renderer.element);
    },
    onUpdate(props) {
      // Reset-on-query-change happens here; `handleRowsChange` above only
      // ever clamps. See `MenuNavState.setQuery`'s doc comment for why the
      // two must stay separate.
      nav.setQuery(props.query);
      latestCommand = props.command;
      renderer?.updateProps({
        query: props.query,
        agents: opts.getAgents(),
        sessions: opts.getSessions(),
        currentSessionId: opts.getCurrentSessionId(),
        selectedIndex: nav.getSelectedIndex(),
        onSelect,
        onHover,
      });
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
    ...baseSuggestion('@', MENTION_PLUGIN_KEY, controller),
    command: ({ editor, range, props: row }) => {
      editor.chain().focus().deleteRange(range).run();
      insertMention(editor, { kind: row.kind, label: row.label, value: row.value });
    },
  };
}
