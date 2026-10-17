import { type EditorState, StateEffect, StateField, type TransactionSpec } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/** The start of the line to mark, or null to clear the mark. */
const setTargetLine = StateEffect.define<number | null>();

/**
 * The line a jump landed on (a content-search match). A read-only viewer
 * draws no cursor and no active line, so without a mark nothing shows which
 * of the visible lines matched. `bg-active` is the persistent-selection token.
 */
const targetLineMark = Decoration.line({ class: 'cm-target-line bg-active' });

/** Holds the target-line mark. Add it to the editor's extensions. */
export const targetLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setTargetLine)) {
        next = effect.value === null ? Decoration.none : Decoration.set([targetLineMark.range(effect.value)]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The transaction that puts the cursor on `targetLine` (1-based, clamped to
 * the document), scrolls it to the middle of the view and marks it.
 */
export function jumpToLine(state: EditorState, targetLine: number): TransactionSpec {
  const line = state.doc.line(Math.max(1, Math.min(targetLine, state.doc.lines)));
  return {
    selection: { anchor: line.from },
    effects: [EditorView.scrollIntoView(line.from, { y: 'center' }), setTargetLine.of(line.from)],
  };
}
