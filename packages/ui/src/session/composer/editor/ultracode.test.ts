import { Editor } from '@tiptap/core';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { afterEach, describe, expect, test } from 'bun:test';

import { baseExtensions } from './extensions';
import {
  dismissUltracode,
  hasUltracodeKeyword,
  isUltracodeDismissKey,
  UltracodeHighlight,
  ultracodePluginKey,
} from './ultracode';

// The composer's real schema and the real plugin, from a headless `@tiptap/core`
// Editor (composer-editor.test.ts's pattern). A headless editor keeps its plugins on
// `extensionManager`, not on `state`, so the state here is built from them and every
// transaction is applied by hand: the same `apply` ProseMirror runs in the browser.
const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function composer(text: string) {
  const editor = new Editor({
    extensions: [...baseExtensions(() => ''), UltracodeHighlight],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  editors.push(editor);
  const { schema } = editor;
  const paragraph = schema.nodes.paragraph!.create(null, text ? schema.text(text) : null);
  let state = EditorState.create({
    schema,
    doc: schema.nodes.doc!.create(null, paragraph),
    plugins: editor.extensionManager.plugins,
  });
  const dispatch = (tr: Transaction) => {
    state = state.apply(tr);
  };
  return {
    get state() {
      return state;
    },
    get plugin() {
      return ultracodePluginKey.getState(state)!;
    },
    dispatch,
    /** Type at the end of the text. */
    type: (more: string) => dispatch(state.tr.insertText(more, state.doc.content.size - 1)),
    caret: (pos: number) => dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos))),
    clear: () => dispatch(state.tr.delete(1, state.doc.content.size - 1)),
  };
}

const key = (overrides: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides }) as KeyboardEvent;

describe('ultracode keyword', () => {
  test('marks every whole-word occurrence, in any case', () => {
    const c = composer('ultracode: audit routes, then ULTRACODE again');
    expect(c.plugin.active).toBe(true);
    expect(c.plugin.ranges).toEqual([
      { from: 1, to: 10 },
      { from: 31, to: 40 },
    ]);
    expect(c.plugin.decorations.find()).toHaveLength(2);
  });

  test('leaves a word that only contains it alone', () => {
    expect(composer('ultracoder myultracode ultracodes').plugin.active).toBe(false);
    expect(hasUltracodeKeyword('ultracoder')).toBe(false);
    expect(hasUltracodeKeyword('run this ultracode')).toBe(true);
    // `lastIndex` of the shared global regex never leaks between calls.
    expect(hasUltracodeKeyword('ultracode')).toBe(true);
    expect(hasUltracodeKeyword('ultracode')).toBe(true);
  });

  test('marks the keyword as it is typed, and drops the mark when it is deleted', () => {
    const c = composer('');
    expect(c.plugin.active).toBe(false);
    c.type('run this as ultracode');
    expect(c.plugin.active).toBe(true);
    c.dispatch(c.state.tr.delete(13, c.state.doc.content.size - 1));
    expect(c.state.doc.textContent).toBe('run this as ');
    expect(c.plugin.active).toBe(false);
  });

  test('the prompt text never changes', () => {
    const c = composer('ultracode: fix the flaky tests');
    expect(c.state.doc.textContent).toBe('ultracode: fix the flaky tests');
  });

  test('Alt+W dismisses it for this prompt, and typing does not bring it back', () => {
    const c = composer('ultracode: audit');
    expect(isUltracodeDismissKey(key({ altKey: true, code: 'KeyW', key: '∑' }), c.state)).toBe(true);
    expect(isUltracodeDismissKey(key({ ctrlKey: true, altKey: true, code: 'KeyW' }), c.state)).toBe(false);
    expect(isUltracodeDismissKey(key({ code: 'KeyW', key: 'w' }), c.state)).toBe(false);
    expect(dismissUltracode(c.state, c.dispatch)).toBe(true);
    expect(c.plugin).toMatchObject({ dismissed: true, active: false, ranges: [] });
    expect(c.state.doc.textContent).toBe('ultracode: audit');
    c.type(' every route, ultracode');
    expect(c.plugin.active).toBe(false);
    // Nothing is marked, so the key is the editor's again.
    expect(isUltracodeDismissKey(key({ altKey: true, code: 'KeyW' }), c.state)).toBe(false);
    expect(dismissUltracode(c.state, c.dispatch)).toBe(false);
  });

  test('Backspace dismisses only with the caret right after a marked keyword', () => {
    const c = composer('ultracode now');
    c.caret(10);
    expect(isUltracodeDismissKey(key({ key: 'Backspace' }), c.state)).toBe(true);
    expect(isUltracodeDismissKey(key({ key: 'Backspace', shiftKey: true }), c.state)).toBe(false);
    c.caret(14);
    expect(isUltracodeDismissKey(key({ key: 'Backspace' }), c.state)).toBe(false);
  });

  test('an empty composer (the prompt was sent or cleared) arms the keyword again', () => {
    const c = composer('ultracode: audit');
    dismissUltracode(c.state, c.dispatch);
    expect(c.plugin.dismissed).toBe(true);
    c.clear();
    expect(c.plugin.dismissed).toBe(false);
    c.type('ultracode next');
    expect(c.plugin.active).toBe(true);
  });
});
