import type { EditorView } from '@tiptap/pm/view';

/**
 * Is the caret on the editor's FIRST visual row?
 *
 * Up takes the queue back only from there. Anywhere else Up must keep its
 * ordinary job — moving the caret up a wrapped or multi-line draft.
 *
 * - a range selection is never "on a row";
 * - the caret must sit in the document's first top-level block;
 * - `endOfTextblock('up')` is ProseMirror's own visual test: true when moving
 *   up would leave the textblock, which accounts for soft wrapping.
 */
export function isCursorOnFirstVisualLine(
  view: Pick<EditorView, 'state' | 'endOfTextblock'>,
): boolean {
  const { selection } = view.state;
  if (!selection.empty) return false;
  if (selection.$head.index(0) !== 0) return false;
  return view.endOfTextblock('up');
}
