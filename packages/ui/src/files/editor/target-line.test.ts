import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { jumpToLine, targetLineField } from './target-line';

/** The start offsets of the lines the field marks, and their class. */
function marked(state: EditorState) {
  const out: { from: number; className: string }[] = [];
  state.field(targetLineField).between(0, state.doc.length, (from, _to, deco) => {
    out.push({ from, className: String(deco.spec.class) });
  });
  return out;
}

// KRTX-1723: a content-search match opens its file at the matched line. The
// viewer is read-only, so the line itself must carry the mark.
describe('jumpToLine', () => {
  const doc = Array.from({ length: 400 }, (_, i) => `row ${i + 1}`).join('\n');
  const state = EditorState.create({ doc, extensions: [targetLineField] });

  test('puts the cursor on the line, scrolls to it and marks it', () => {
    const spec = jumpToLine(state, 350);
    const next = state.update(spec).state;
    const line = next.doc.line(350);
    expect(next.selection.main.head).toBe(line.from);
    expect(Array.isArray(spec.effects) ? spec.effects.length : 0).toBe(2);
    expect(marked(next)).toEqual([{ from: line.from, className: 'cm-target-line bg-active' }]);
  });

  test('a second jump moves the mark; it never marks two lines', () => {
    const first = state.update(jumpToLine(state, 10)).state;
    const second = first.update(jumpToLine(first, 20)).state;
    expect(marked(second)).toEqual([{ from: second.doc.line(20).from, className: 'cm-target-line bg-active' }]);
  });

  test('clamps a line past either end of the document', () => {
    expect(marked(state.update(jumpToLine(state, 9999)).state)[0]!.from).toBe(state.doc.line(400).from);
    expect(marked(state.update(jumpToLine(state, 0)).state)[0]!.from).toBe(0);
  });

  test('no jump, no mark', () => {
    expect(marked(state)).toEqual([]);
  });
});
