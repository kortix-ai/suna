import { Editor, type JSONContent } from '@tiptap/core';
import { PLUGIN_KEY as PLACEHOLDER_PLUGIN_KEY } from '@tiptap/extensions';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, test } from 'bun:test';

import { baseExtensions } from './extensions';
import {
  createSubmitOnEnterHandler,
  createUpdateHandler,
  getEditorDocument,
  insertTextAtCursor,
  setEditorDocument,
  trackEmptyBoundary,
} from './composer-editor';
import { mergeFailedSubmissionText } from '../../composer-draft-recovery';
import { appendTranscribedText, planPrefillMerge, textToDocument } from '../composer-logic';
import { MentionNode } from './mention-node';
import { serializeDocument } from './serialize';

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

function mentionNode(kind: 'file' | 'agent' | 'session', label: string, value = ''): JSONContent {
  return { type: 'mention', attrs: { kind, label, value } };
}

/**
 * Task 13, fix round 1, Important 2 — `getEditorDocument`/`setEditorDocument`/
 * `insertTextAtCursor` (`composer-editor.tsx`) were added but shipped with no
 * test of their own; `composer.tsx`'s mention-preserving recovery and the
 * `insertAtCursor` type-ahead fix both depend entirely on these three
 * behaving as documented. These drive the same headless, no-DOM
 * `@tiptap/core` `Editor` the suites above already use — `serializeDocument`
 * (the exact function `getContent()` calls in production) is the assertion
 * surface, so a mention surviving here is proof it survives through the
 * REAL serialization path, not a hand-rolled stand-in for it.
 */
describe('getEditorDocument / setEditorDocument — the mention-preserving snapshot/restore primitives', () => {
  test('setDocument(replace) with a mention atom node — serializeDocument reports it, label intact', () => {
    const editor = createHeadlessEditor(() => {});
    const doc: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [mentionNode('file', 'README.md')] }],
    };

    setEditorDocument(editor, doc);

    const { mentions } = serializeDocument(editor.state.doc);
    expect(mentions).toEqual([{ kind: 'file', label: 'README.md' }]);
  });

  test('getDocument() -> setDocument() across two INDEPENDENT editors preserves the mention atom', () => {
    // Mirrors the real shape of the fix: `composer.tsx` snapshots via
    // `getDocument()` on one editor lifetime (before a send fails) and
    // restores via `setDocument()` later — potentially after the editor
    // itself was torn down and rebuilt (a fresh lazy-chunk mount). Using two
    // separate `Editor` instances here, rather than round-tripping through
    // the same one, is what actually exercises that the SNAPSHOT itself
    // (not just editor-internal state) carries the mention.
    const source = createHeadlessEditor(() => {});
    setEditorDocument(source, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [mentionNode('agent', 'Analyst')] }],
    });
    const snapshot = getEditorDocument(source);

    const target = createHeadlessEditor(() => {});
    setEditorDocument(target, snapshot);

    const { mentions } = serializeDocument(target.state.doc);
    expect(mentions).toEqual([{ kind: 'agent', label: 'Analyst' }]);
  });

  test('getEditorDocument/setEditorDocument/insertTextAtCursor no-op safely with a null editor', () => {
    expect(getEditorDocument(null)).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(() => setEditorDocument(null, { type: 'doc', content: [] })).not.toThrow();
    expect(() => insertTextAtCursor(null, 'x')).not.toThrow();
  });
});

/**
 * Task 13, fix round 1, Important 2's named regression guard: `insertAtCursor`
 * must insert INLINE at the current selection, never split the document into
 * a new paragraph. This is the exact bug fix-round-1's review reproduced —
 * `insertAtCursor` at position 6 of "hello world" gives "helloX world" with
 * `childCount === 1`, while the OLD `insertContent([{type:'paragraph'}, ...])`
 * path (what `onTypeAhead` used before this primitive existed) at the same
 * position corrupts the document into more than one paragraph.
 */
describe('insertTextAtCursor — inserts inline, never splits the document', () => {
  test('inserting mid-word keeps a single paragraph and lands exactly at the cursor', () => {
    const editor = createHeadlessEditor(() => {});
    for (const char of 'hello world') typeChar(editor, char);
    editor.commands.setTextSelection(6); // between "hello" and " world"

    insertTextAtCursor(editor, 'X');

    expect(editor.getText()).toBe('helloX world');
    expect(editor.state.doc.childCount).toBe(1);
  });

  test('the OLD paragraph-splitting approach, same position, DOES split the document (comparison)', () => {
    // Not a call into production code — this reconstructs the exact
    // `insertContent([{ type: 'paragraph' }, ...])` shape `onTypeAhead`
    // incorrectly used for a single redirected keystroke before this fix.
    // Included so the "regression guard" claim above is falsifiable: if
    // `insertTextAtCursor` ever regressed back to this shape, `childCount`
    // would jump from 1 to 2 exactly as it does here.
    const editor = createHeadlessEditor(() => {});
    for (const char of 'hello world') typeChar(editor, char);
    editor.commands.setTextSelection(6);

    editor.commands.insertContent([{ type: 'paragraph' }, { type: 'text', text: 'X' }]);

    expect(editor.state.doc.childCount).toBeGreaterThan(1);
  });

  test('a no-op on an empty string — does not touch the document', () => {
    const editor = createHeadlessEditor(() => {});
    typeChar(editor, 'h');
    const before = editor.getText();

    insertTextAtCursor(editor, '');

    expect(editor.getText()).toBe(before);
  });

  test('splits on newlines into hard breaks rather than corrupting via a bare-string HTML parse', () => {
    const editor = createHeadlessEditor(() => {});

    insertTextAtCursor(editor, 'line one\nline two');

    expect(editor.getText()).toContain('line one');
    expect(editor.getText()).toContain('line two');
    expect(editor.state.doc.childCount).toBe(1); // still one paragraph — hardBreak, not a paragraph split
  });
});

/**
 * Task 14, compatibility matrix row 10 (`Enter` sends, `Shift+Enter` newline).
 *
 * These assert through `serializeDocument` — the REAL send path
 * (`composer-editor.tsx`'s `getContent()` -> `composer.tsx`'s `handleSubmit`
 * -> `onSend(text, ...)`) — deliberately NOT through `editor.getText()`.
 * The two disagree: `getText()` walks the document by its own route and
 * reported `"line one\nline two"` even while `serializeDocument` returned
 * `"line oneline two"`, which is exactly why every `getText()`-based
 * assertion in this file stayed green through that regression. Any future
 * assertion about what the user actually SENDS belongs here, on
 * `serializeDocument`.
 */
describe('serializeDocument — Shift+Enter hard breaks reach the wire (matrix row 10)', () => {
  test('a hard break between two lines serializes to a newline, not to nothing', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'line one' });
    editor.commands.setHardBreak(); // exactly what Shift+Enter runs
    editor.commands.insertContent({ type: 'text', text: 'line two' });

    // One paragraph containing an inline hardBreak leaf — the block
    // separator cannot supply the newline here, only `leafText` can.
    expect(editor.state.doc.childCount).toBe(1);
    expect(serializeDocument(editor.state.doc).text).toBe('line one\nline two');
  });

  test('the words are never glued together (the exact shape of the regression)', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'alpha' });
    editor.commands.setHardBreak();
    editor.commands.insertContent({ type: 'text', text: 'beta' });

    expect(serializeDocument(editor.state.doc).text).not.toBe('alphabeta');
  });

  test('a multi-line insertAtCursor round-trips its newline through the send path', () => {
    const editor = createHeadlessEditor(() => {});

    insertTextAtCursor(editor, 'line one\nline two');

    expect(serializeDocument(editor.state.doc).text).toBe('line one\nline two');
  });

  test('mentions still serialize as @label alongside a hard break', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'see ' });
    editor.commands.insertContent(mentionNode('file', 'auth.ts'));
    editor.commands.setHardBreak();
    editor.commands.insertContent({ type: 'text', text: 'please' });

    const { text, mentions } = serializeDocument(editor.state.doc);
    expect(text).toBe('see @auth.ts\nplease');
    expect(mentions).toEqual([{ kind: 'file', label: 'auth.ts' }]);
  });

  test('paragraph boundaries keep serializing to a newline (unchanged behaviour)', () => {
    const editor = createHeadlessEditor(() => {});
    setEditorDocument(editor, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'para one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'para two' }] },
      ],
    });

    expect(serializeDocument(editor.state.doc).text).toBe('para one\npara two');
  });
});

/**
 * Task 14, matrix rows 1 and 21 — the round trip through a REAL editor.
 *
 * `composer-logic.test.ts` proves the two planners produce the right JSON.
 * These prove the rest of the path: that feeding that JSON through the same
 * `setEditorDocument` the component calls, and reading it back through the
 * same `serializeDocument` the SEND path calls, produces the exact string the
 * old string-based composer produced. Row 10 is the reason this second layer
 * exists at all — there, the planner-equivalent logic was fine and the
 * document was fine, and the bug was entirely in what came out the other end.
 *
 * Row 1 asserts against `mergeFailedSubmissionText` itself rather than a
 * hardcoded string, so the restored behaviour is pinned to the ORIGINAL
 * implementation rather than to my reading of it.
 */
describe('merge-mode prefill and transcription round-trip to the old strings', () => {
  test('row 1: merge prefill serializes to exactly mergeFailedSubmissionText(current, prefill)', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'my draft' });

    const merged = planPrefillMerge({
      prefillDoc: textToDocument('recovered'),
      prefillIsEmpty: false,
      currentDoc: getEditorDocument(editor),
      currentIsEmpty: editor.isEmpty,
    });
    expect(merged).not.toBeNull();
    setEditorDocument(editor, merged!);

    expect(serializeDocument(editor.state.doc).text).toBe(
      mergeFailedSubmissionText('my draft', 'recovered'),
    );
    // Spelled out, so a change to either side is visible in the diff.
    expect(serializeDocument(editor.state.doc).text).toBe('recovered\n\nmy draft');
  });

  test('row 1: an identical prefill is a no-op — the message is not doubled', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'same' });

    const merged = planPrefillMerge({
      prefillDoc: textToDocument('same'),
      prefillIsEmpty: false,
      currentDoc: getEditorDocument(editor),
      currentIsEmpty: editor.isEmpty,
    });

    expect(merged).toBeNull(); // nothing written, caret untouched
    expect(serializeDocument(editor.state.doc).text).toBe(
      mergeFailedSubmissionText('same', 'same'),
    );
    expect(serializeDocument(editor.state.doc).text).toBe('same');
  });

  test('row 1: a files-only prefill leaves the document structurally untouched', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'my draft' });
    const before = editor.state.doc.childCount;

    const merged = planPrefillMerge({
      prefillDoc: textToDocument(''),
      prefillIsEmpty: true,
      currentDoc: getEditorDocument(editor),
      currentIsEmpty: editor.isEmpty,
    });

    expect(merged).toBeNull();
    // The regression added two blank paragraphs here (childCount 1 -> 3).
    expect(editor.state.doc.childCount).toBe(before);
    expect(serializeDocument(editor.state.doc).text).toBe('my draft');
  });

  test('row 1: mentions on both sides survive the merge as structured entries', () => {
    const editor = createHeadlessEditor(() => {});
    setEditorDocument(editor, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [mentionNode('file', 'draft.ts')] }],
    });

    const merged = planPrefillMerge({
      prefillDoc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [mentionNode('file', 'recovered.ts')] }],
      },
      prefillIsEmpty: false,
      currentDoc: getEditorDocument(editor),
      currentIsEmpty: editor.isEmpty,
    });
    setEditorDocument(editor, merged!);

    expect(serializeDocument(editor.state.doc).mentions).toEqual([
      { kind: 'file', label: 'recovered.ts' },
      { kind: 'file', label: 'draft.ts' },
    ]);
  });

  test('row 21: transcription serializes to "draft transcript" — a space, not a block break', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'hello' });

    setEditorDocument(
      editor,
      appendTranscribedText(getEditorDocument(editor), editor.isEmpty, 'transcribed'),
    );

    expect(serializeDocument(editor.state.doc).text).toBe('hello transcribed');
    expect(editor.state.doc.childCount).toBe(1); // one paragraph, no block split
  });

  test('row 21: dictating with the caret mid-draft still appends at the END', () => {
    const editor = createHeadlessEditor(() => {});
    editor.commands.insertContent({ type: 'text', text: 'hello world' });
    editor.commands.setTextSelection(6); // between "hello" and " world"

    setEditorDocument(
      editor,
      appendTranscribedText(getEditorDocument(editor), editor.isEmpty, 'dictated'),
    );

    // The regression produced "hello\n\ndictated\n world" — the transcript
    // dropped into the middle of the sentence at the stale caret.
    expect(serializeDocument(editor.state.doc).text).toBe('hello world dictated');
  });

  test('row 21: transcription into an empty composer has no leading space', () => {
    const editor = createHeadlessEditor(() => {});

    setEditorDocument(
      editor,
      appendTranscribedText(getEditorDocument(editor), editor.isEmpty, 'transcribed'),
    );

    expect(serializeDocument(editor.state.doc).text).toBe('transcribed');
  });
});

describe('createUpdateHandler — per-change doc snapshots alongside the empty boundary', () => {
  test('fires onDocChange for every keystroke while onEmptyChange fires once', () => {
    const boundaries: boolean[] = [];
    const docs: JSONContent[] = [];
    const emptiness: boolean[] = [];
    const editor = new Editor({
      extensions: [...baseExtensions(() => 'Type a message'), MentionNode],
      onUpdate: createUpdateHandler(
        (isEmpty) => boundaries.push(isEmpty),
        (doc, isEmpty) => {
          docs.push(doc);
          emptiness.push(isEmpty);
        },
      ),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    for (const char of 'hello') {
      editor.commands.insertContent({ type: 'text', text: char });
    }

    // The whole point of the composition: the draft saver sees every change,
    // the toolbar still sees exactly one boundary crossing.
    expect(docs).toHaveLength(5);
    expect(boundaries).toEqual([false]);
    // Emptiness rides with every snapshot, read live from the same editor.
    expect(emptiness).toEqual([false, false, false, false, false]);
    expect(editor.getText()).toBe('hello');
  });

  test('the snapshot handed to onDocChange is the live document, mentions included', () => {
    const docs: JSONContent[] = [];
    const editor = new Editor({
      extensions: [...baseExtensions(() => 'Type a message'), MentionNode],
      onUpdate: createUpdateHandler(
        () => {},
        (doc) => docs.push(doc),
      ),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    editor.commands.insertContent({
      type: 'mention',
      attrs: { kind: 'file', label: 'README.md', value: 'README.md' },
    });

    const last = docs.at(-1);
    expect(JSON.stringify(last)).toContain('"type":"mention"');
  });

  test('deleting the last character reports the empty boundary and an empty doc', () => {
    const boundaries: boolean[] = [];
    const docs: JSONContent[] = [];
    const emptiness: boolean[] = [];
    const editor = new Editor({
      extensions: [...baseExtensions(() => 'Type a message'), MentionNode],
      onUpdate: createUpdateHandler(
        (isEmpty) => boundaries.push(isEmpty),
        (doc, isEmpty) => {
          docs.push(doc);
          emptiness.push(isEmpty);
        },
      ),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    editor.commands.insertContent({ type: 'text', text: 'a' });
    // A range delete, not `clearContent()`: that calls `setContent('')` with a
    // bare string, which TipTap always routes through `window.DOMParser` and
    // which therefore throws with no DOM. See this file's header — production
    // `clear()` avoids it the same way, via EMPTY_DOC.
    editor.commands.deleteRange({ from: 1, to: 2 });

    expect(boundaries).toEqual([false, true]);
    expect(editor.isEmpty).toBe(true);
    expect(docs).toHaveLength(2);
    // The final snapshot reports empty, which is what makes the host delete
    // the stored draft rather than persist an empty document.
    expect(emptiness).toEqual([false, true]);
  });
});
