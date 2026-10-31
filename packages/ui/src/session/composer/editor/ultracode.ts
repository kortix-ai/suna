import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * The `ultracode` keyword, as Claude Code's dynamic workflows treat it: a
 * prompt that holds the word runs as a workflow of agents. The composer marks
 * each occurrence in place and the host shows a one-line hint, so the person
 * sees the opt-in before they send. The prompt text never changes: the word
 * is sent as typed, and the agent reads it.
 *
 * Alt+W (Option+W on a Mac), or Backspace right after a marked word, dismisses
 * the mark and the hint for this prompt. A dismissed prompt stays dismissed
 * while the person keeps typing; an empty composer (the prompt was sent or
 * cleared) arms the keyword again.
 */

/** Whole word, any case. `\b` keeps `ultracoder` and `myultracode` plain text. */
const KEYWORD = /\bultracode\b/gi;

/** The utility classes of a marked keyword: the mention chip's tint, no padding (the caret must not jump). */
export const ULTRACODE_MARK_CLASS = 'kortix-ultracode rounded-sm bg-primary/[0.08] font-medium text-foreground';

export interface UltracodeRange {
  from: number;
  to: number;
}

/** Every occurrence of the keyword in a document, as document positions. */
export function findUltracodeRanges(doc: ProseMirrorNode): UltracodeRange[] {
  const ranges: UltracodeRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const match of node.text.matchAll(KEYWORD)) {
      const from = pos + (match.index ?? 0);
      ranges.push({ from, to: from + match[0].length });
    }
  });
  return ranges;
}

/** True for a plain-text keyword check (the sent prompt, a test). Same rule as the editor mark. */
export function hasUltracodeKeyword(text: string): boolean {
  KEYWORD.lastIndex = 0;
  const found = KEYWORD.test(text);
  KEYWORD.lastIndex = 0;
  return found;
}

export interface UltracodeState {
  /** The person dismissed the keyword for this prompt. */
  dismissed: boolean;
  ranges: UltracodeRange[];
  /** At least one marked keyword: the host shows the hint. */
  active: boolean;
  decorations: DecorationSet;
}

export const ultracodePluginKey = new PluginKey<UltracodeState>('ultracode');

const isBlank = (doc: ProseMirrorNode) => doc.textContent.trim().length === 0;

function stateFor(doc: ProseMirrorNode, dismissed: boolean): UltracodeState {
  const ranges = dismissed ? [] : findUltracodeRanges(doc);
  return {
    dismissed,
    ranges,
    active: ranges.length > 0,
    decorations: ranges.length
      ? DecorationSet.create(
          doc,
          ranges.map(({ from, to }) => Decoration.inline(from, to, { class: ULTRACODE_MARK_CLASS, 'data-ultracode': '' })),
        )
      : DecorationSet.empty,
  };
}

/** The next state after a transaction: a dismiss meta sets it, an empty document resets it. */
export function nextUltracodeState(tr: Transaction, previous: UltracodeState, state: EditorState): UltracodeState {
  const meta = tr.getMeta(ultracodePluginKey) as { dismiss?: boolean } | undefined;
  let dismissed = meta?.dismiss ? true : previous.dismissed;
  if (dismissed && isBlank(state.doc)) dismissed = false;
  if (!tr.docChanged && dismissed === previous.dismissed) return previous;
  return stateFor(state.doc, dismissed);
}

/** Dismiss the keyword for this prompt. Returns false when nothing is marked. */
export function dismissUltracode(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (!ultracodePluginKey.getState(state)?.active) return false;
  dispatch?.(state.tr.setMeta(ultracodePluginKey, { dismiss: true }));
  return true;
}

/** Alt+W anywhere, or Backspace with the caret right after a marked keyword. */
export function isUltracodeDismissKey(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  state: EditorState,
): boolean {
  const plugin = ultracodePluginKey.getState(state);
  if (!plugin?.active) return false;
  // `code`, not `key`: Option+W on a Mac types `∑`.
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyW') return true;
  if (event.key !== 'Backspace' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const { empty, from } = state.selection;
  return empty && plugin.ranges.some((range) => range.to === from);
}

export interface UltracodeOptions {
  /** Fires when the hint should appear or go: a marked keyword exists, or none does. */
  onActiveChange?: (active: boolean) => void;
}

export const UltracodeHighlight = Extension.create<UltracodeOptions>({
  name: 'ultracodeHighlight',
  addOptions() {
    return { onActiveChange: undefined };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<UltracodeState>({
        key: ultracodePluginKey,
        state: {
          init: (_config, state) => stateFor(state.doc, false),
          apply: (tr, previous, _old, state) => nextUltracodeState(tr, previous, state),
        },
        props: {
          decorations: (state) => ultracodePluginKey.getState(state)?.decorations ?? DecorationSet.empty,
          handleKeyDown: (view, event) => {
            if (!isUltracodeDismissKey(event, view.state)) return false;
            event.preventDefault();
            return dismissUltracode(view.state, view.dispatch);
          },
        },
        view: (view) => {
          let reported = ultracodePluginKey.getState(view.state)?.active ?? false;
          if (reported) options.onActiveChange?.(true);
          return {
            update: (next) => {
              const active = ultracodePluginKey.getState(next.state)?.active ?? false;
              if (active === reported) return;
              reported = active;
              options.onActiveChange?.(active);
            },
            destroy: () => {
              if (reported) options.onActiveChange?.(false);
            },
          };
        },
      }),
    ];
  },
});
