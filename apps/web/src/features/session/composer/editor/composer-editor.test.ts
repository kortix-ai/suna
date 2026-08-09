import { Editor } from '@tiptap/core';
import { PLUGIN_KEY as PLACEHOLDER_PLUGIN_KEY } from '@tiptap/extensions';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, test } from 'bun:test';

import { baseExtensions } from './extensions';
import { createSubmitOnEnterHandler, trackEmptyBoundary } from './composer-editor';
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
function createHeadlessEditor(
  onEmptyChange: (isEmpty: boolean) => void,
  getPlaceholder: () => string = () => 'Type a message',
): Editor {
  return new Editor({
    extensions: [...baseExtensions(getPlaceholder), MentionNode],
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

/**
 * Fix round 1, Important 1 — a disabled composer must never call onSubmit.
 * `event.preventDefault()` needs no real DOM: it's just a method call the
 * handler invokes on whatever object it's given, so a minimal fake
 * satisfying the one property (`key`, `shiftKey`) and one method
 * (`preventDefault`) the handler actually reads is a faithful stand-in —
 * this doesn't need a browser or even a real `Editor`, unlike the suites
 * above.
 */
describe('createSubmitOnEnterHandler', () => {
  function fakeEvent(key: string, shiftKey = false) {
    let prevented = false;
    const event = { key, shiftKey, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent;
    return { event, wasPrevented: () => prevented };
  }

  test('Enter (no shift) while enabled calls onSubmit, prevents default, and reports handled', () => {
    let submitted = 0;
    const handler = createSubmitOnEnterHandler(
      () => submitted++,
      () => false,
    );
    const { event, wasPrevented } = fakeEvent('Enter');

    const handled = handler(null as unknown as EditorView, event);

    expect(submitted).toBe(1);
    expect(wasPrevented()).toBe(true);
    expect(handled).toBe(true);
  });

  test('Enter while disabled does NOT call onSubmit, and reports unhandled', () => {
    // This is the bug: editable=false alone does not stop this handler from
    // firing, because it's not a document edit — it's an imperative
    // onSubmit() call. The disabled guard has to be explicit.
    let submitted = 0;
    const handler = createSubmitOnEnterHandler(
      () => submitted++,
      () => true,
    );
    const { event, wasPrevented } = fakeEvent('Enter');

    const handled = handler(null as unknown as EditorView, event);

    expect(submitted).toBe(0);
    expect(wasPrevented()).toBe(false);
    expect(handled).toBe(false);
  });

  test('Shift+Enter while enabled does not call onSubmit (default newline behaviour proceeds)', () => {
    let submitted = 0;
    const handler = createSubmitOnEnterHandler(
      () => submitted++,
      () => false,
    );
    const { event, wasPrevented } = fakeEvent('Enter', true);

    const handled = handler(null as unknown as EditorView, event);

    expect(submitted).toBe(0);
    expect(wasPrevented()).toBe(false);
    expect(handled).toBe(false);
  });

  test('any other key is a no-op regardless of disabled state', () => {
    let submitted = 0;
    const handler = createSubmitOnEnterHandler(
      () => submitted++,
      () => false,
    );
    const { event, wasPrevented } = fakeEvent('a');

    const handled = handler(null as unknown as EditorView, event);

    expect(submitted).toBe(0);
    expect(wasPrevented()).toBe(false);
    expect(handled).toBe(false);
  });
});

/**
 * Fix round 1, Important 2 — `placeholder` must reach the editor after
 * construction, not just at mount.
 *
 * This drives the REAL `@tiptap/extensions` Placeholder plugin, headlessly,
 * the same way the suites above drive the real Editor. `editor.state.plugins`
 * is empty in headless mode (plugins are only attached to state inside
 * `createView()`, which requires a DOM and is never called here — see the
 * file header), so this reads the plugin straight from
 * `editor.extensionManager.plugins` instead, which IS populated at
 * construction regardless of mount. `plugin.props.decorations` is the exact
 * function ProseMirror calls on every view redraw; calling it directly with
 * `editor.state` reproduces that call without needing a view.
 *
 * The decoration's rendered `data-placeholder` value lives on
 * `decoration.type.attrs` — an `@internal`-tagged field with no accessor in
 * `@tiptap/pm/view`'s public `.d.ts` (verified against
 * `node_modules/.../prosemirror-view/dist/index.d.ts`: `Decoration` only
 * declares `from`, `to`, and `get spec()` publicly; `createPlaceholderDecoration`
 * in `@tiptap/extensions` passes the placeholder text as `attrs`, not `spec`,
 * so `.spec` is empty). `@internal` is a TSDoc annotation, not a runtime
 * guard — the field exists on the compiled object exactly as read here,
 * confirmed empirically against the installed package before writing this
 * assertion (see task-3-report.md, fix round 1).
 */
describe('baseExtensions — Placeholder reads a live getter, not a value frozen at construction', () => {
  function currentPlaceholderText(editor: Editor): string | undefined {
    const plugin = editor.extensionManager.plugins.find((p) => p.spec.key === PLACEHOLDER_PLUGIN_KEY);
    if (!plugin?.props.decorations) return undefined;
    // .call(plugin, ...), not plugin.props.decorations(...): the declared
    // signature types `decorations` with `this: Plugin<any>` (ProseMirror
    // binds plugin props to their owning Plugin at call time), and calling
    // it as a plain method off `props` would bind `this` to `props` instead,
    // which tsc correctly rejects (TS2684).
    const decorations = plugin.props.decorations.call(plugin, editor.state as never);
    const decoration = (decorations as { find?: () => unknown[] } | null)?.find?.()[0];
    const attrs = (decoration as { type?: { attrs?: Record<string, string> } } | undefined)?.type?.attrs;
    return attrs?.['data-placeholder'];
  }

  test('the rendered placeholder reflects whatever the getter returns right now', () => {
    let placeholder = 'Type a message';
    const editor = createHeadlessEditor(
      () => {},
      () => placeholder,
    );

    expect(currentPlaceholderText(editor)).toBe('Type a message');

    // This is the whole bug: `editor.setOptions()` (what @tiptap/react calls
    // on every ComposerEditor re-render) never rebuilds this plugin — see
    // extensions.ts's comment. A frozen-string Placeholder.configure would
    // show "Type a message" forever, no matter what the `placeholder` prop
    // becomes. Mutating the outer variable and re-reading proves the getter,
    // not the plugin, is what's live.
    placeholder = 'Approve or deny the action above to continue…';

    expect(currentPlaceholderText(editor)).toBe('Approve or deny the action above to continue…');
  });

  test('a second, independent getter is unaffected — no shared/global state', () => {
    let placeholderA = 'A';
    const placeholderB = 'B';
    const editorA = createHeadlessEditor(
      () => {},
      () => placeholderA,
    );
    const editorB = createHeadlessEditor(
      () => {},
      () => placeholderB,
    );

    placeholderA = 'A changed';

    expect(currentPlaceholderText(editorA)).toBe('A changed');
    expect(currentPlaceholderText(editorB)).toBe('B');
  });
});

/**
 * Fix round 1, Important 1 — the foundation `composer-editor.tsx`'s
 * `useEffect(() => editor?.setEditable(!disabled), [editor, disabled])`
 * depends on: that `editor.setEditable()` itself actually flips
 * `isEditable`, headlessly. The REACT-level wiring (the effect, and the
 * `disabled` prop reaching it) needs a renderer and is NOT covered here —
 * see task-3-report.md for what that leaves unverified.
 */
describe('editor.setEditable — the mechanism the disabled effect depends on', () => {
  test('setEditable(false) then setEditable(true) round-trips isEditable', () => {
    const editor = createHeadlessEditor(() => {});

    expect(editor.isEditable).toBe(true);

    editor.setEditable(false);
    expect(editor.isEditable).toBe(false);

    editor.setEditable(true);
    expect(editor.isEditable).toBe(true);
  });
});
