import { Editor } from '@tiptap/core';
import { describe, expect, test } from 'bun:test';

import { baseExtensions } from './extensions';
import { trackEmptyBoundary } from './composer-editor';
import { MentionNode } from './mention-node';

/**
 * No jsdom/happy-dom is registered for `bun test` in this repo
 * (`apps/web/test-setup.ts` adds none — see mention-node.test.ts for the
 * same house pattern), so this drives a REAL `@tiptap/core` `Editor`
 * instance with no DOM at all.
 *
 * This works because TipTap's `Editor` only calls `mount()` — which throws
 * if `document` is undefined — when constructed WITH an `element` option
 * (verified in `node_modules/@tiptap/core/dist/index.js`, `Editor`
 * constructor: `if (this.options.element) { this.mount(this.options.element); }`).
 * Omitting `element` here skips that entirely. Every command
 * (`insertContent`, `deleteRange`, `clearContent`, ...) still dispatches
 * through `editor.view.dispatch(tr)`; without a mounted view, `editor.view`
 * falls back to a Proxy stub (same file, `Editor.view` getter) whose
 * `dispatch` calls `this.dispatchTransaction(tr)` directly. That method
 * updates `editorState` and — critically — still calls
 * `this.emit('update', ...)` whenever a transaction changes the doc. So
 * `onUpdate` fires for real, and `editor.isEmpty` (a pure `state.doc`
 * node-size check) reflects the real post-transaction document. This is a
 * genuine, non-mocked exercise of the exact `onUpdate` wiring
 * composer-editor.tsx installs on `useEditor` — not a hand-rolled boolean
 * toggler standing in for it.
 *
 * Every insertion below uses JSON content (`{ type: 'text', text }`), never
 * a bare string. This isn't just style: `createNodeFromContent` (same file)
 * routes ANY bare string — including the empty-string default `content`, and
 * ANY string passed to `insertContent`/`setContent` — through
 * `elementFromString` -> `window.DOMParser`, which throws with no DOM. This
 * was verified empirically (first draft of this file used bare strings and
 * failed with "there is no window object available") and independently
 * confirms the exact bug composer-editor.tsx's `textToParagraphs` avoids: a
 * bare string is never "plain text" to TipTap, it is always parsed as HTML.
 *
 * NOT covered here, and not coverable without a browser: a real keydown
 * event reaching ProseMirror's own `handleTextInput`/IME composition path.
 * The commands below dispatch the identical doc-changing transactions a real
 * keystroke would, but they skip the DOM event plumbing. That gap needs a
 * live browser and is out of scope for this task (see CLAUDE.md: no browser
 * verification for this change).
 */
function createHeadlessEditor(onEmptyChange: (isEmpty: boolean) => void): Editor {
  return new Editor({
    extensions: [...baseExtensions('Type a message'), MentionNode],
    onUpdate: trackEmptyBoundary(onEmptyChange),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
}

/** Insert one character as JSON text content — see the file header for why. */
function typeChar(editor: Editor, char: string): void {
  editor.commands.insertContent({ type: 'text', text: char });
}

describe('trackEmptyBoundary — fires ONLY on the empty<->non-empty boundary', () => {
  test('typing the first character fires exactly once, with isEmpty=false', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    typeChar(editor, 'h');

    expect(calls).toEqual([false]);
  });

  test('typing a whole word fires ONE time total, not once per keystroke', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    for (const char of 'hello') {
      typeChar(editor, char);
    }

    // 5 keystrokes, 1 boundary crossing (empty -> non-empty on the "h").
    // This is the whole assertion this task exists to prove: if the naive
    // per-keystroke version regresses (onUpdate always calling
    // onEmptyChange), this array has 5 entries instead of 1.
    expect(calls).toEqual([false]);
    expect(editor.getText()).toBe('hello');
  });

  test('editing that never crosses the boundary (non-empty -> non-empty) never fires', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    for (const char of 'hello world') typeChar(editor, char);
    calls.length = 0; // discard the entry boundary, isolate what follows

    for (const char of ' again') typeChar(editor, char);
    editor.commands.deleteRange({ from: 5, to: 7 }); // delete mid-string, stays non-empty

    expect(calls).toEqual([]);
    expect(editor.isEmpty).toBe(false);
  });

  test('deleting the last character fires exactly once, with isEmpty=true', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    typeChar(editor, 'h');
    typeChar(editor, 'i');
    calls.length = 0;

    editor.commands.deleteRange({ from: 0, to: editor.state.doc.content.size });

    expect(calls).toEqual([true]);
    expect(editor.isEmpty).toBe(true);
  });

  test('deleting one character at a time fires ONLY on the final deletion, not per backspace', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    for (const char of 'hey') typeChar(editor, char);
    calls.length = 0;

    // Three backspace-equivalents: remove the last character three times.
    while (!editor.isEmpty) {
      const end = editor.state.doc.content.size - 1;
      editor.commands.deleteRange({ from: end - 1, to: end });
    }

    expect(calls).toEqual([true]);
  });

  test('a full type-then-delete-to-empty round trip fires exactly twice, in order', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    for (const char of 'yo') typeChar(editor, char);
    editor.commands.deleteRange({ from: 0, to: editor.state.doc.content.size });

    expect(calls).toEqual([false, true]);
  });

  test('setContent(emptyDoc) from non-empty fires the exit boundary exactly once', () => {
    // Not editor.commands.clearContent(): it always calls setContent('')
    // internally with a BARE string regardless of environment (real
    // browsers tolerate this because `window` exists there), so it is
    // unusable in this headless suite. The JSON-doc equivalent below is
    // exactly what composer-editor.tsx's own setContent() sends, and is what
    // production `clear()` reduces to once TipTap parses the empty string.
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    for (const char of 'draft') typeChar(editor, char);
    calls.length = 0;

    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });

    expect(calls).toEqual([true]);
  });

  test('inserting an atomic mention node into an empty editor fires the entry boundary once', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    editor.commands.insertContent({
      type: 'mention',
      attrs: { kind: 'file', label: 'README.md', value: '' },
    });

    expect(calls).toEqual([false]);
    expect(editor.isEmpty).toBe(false);
  });

  test('a no-op transaction (selection-only, no doc change) never fires', () => {
    const calls: boolean[] = [];
    const editor = createHeadlessEditor((isEmpty) => calls.push(isEmpty));

    typeChar(editor, 'h');
    typeChar(editor, 'i');
    calls.length = 0;

    editor.commands.setTextSelection(0);

    expect(calls).toEqual([]);
  });
});
