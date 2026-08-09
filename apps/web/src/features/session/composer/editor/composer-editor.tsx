'use client';

import { cn } from '@/lib/utils';
import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { EditorContent, useEditor } from '@tiptap/react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';

import type { TrackedMention } from '../types';
import { baseExtensions } from './extensions';
import { MentionNode } from './mention-node';
import { serializeDocument } from './serialize';

export interface ComposerEditorHandle {
  getContent(): { text: string; mentions: TrackedMention[] };
  /**
   * `text` — not `markdown`. There is no markdown parser in the extension
   * list (extensions.ts), so this never interprets `**bold**`/`# heading`
   * syntax; it only ever inserts literal characters. Markdown parsing on
   * prefill (starter prompts, failed-send recovery) is deliberately out of
   * scope for this task.
   */
  setContent(text: string, mode?: 'replace' | 'merge'): void;
  clear(): void;
  focus(): void;
  isEmpty(): boolean;
  /**
   * The contenteditable DOM node (`editor.view.dom`). `useComposerFocus`
   * (`hooks/use-composer-focus.ts`) needs a `RefObject<HTMLElement>` aimed
   * at this exact element — it calls `.focus()` and
   * `.contains(document.activeElement)` on it directly — and `ComposerEditor`
   * otherwise exposes no element, no `editor`, and `EditorContent` itself
   * takes no ref. `autoFocus` only covers TipTap's own mount-time
   * `autofocus`; it does not cover re-focus-when-revealed, the
   * `focus-session-textarea` event, or the type-ahead redirect, all of which
   * live in `useComposerFocus`. Wiring the hook to this element is Task 12's
   * job, not this one's — this only exposes the element.
   */
  getElement(): HTMLElement | null;
}

export interface ComposerEditorProps {
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onSubmit: () => void;
  /**
   * Fires ONLY on the empty↔non-empty boundary — once when the first character
   * is typed, once when the last is deleted, never in between. This is the
   * whole reason the toolbar stops re-rendering per keystroke.
   */
  onEmptyChange: (isEmpty: boolean) => void;
}

/**
 * Wraps `onEmptyChange` so it fires ONLY on the empty<->non-empty boundary.
 * Exported (rather than kept as an inline `useEditor({ onUpdate })` closure)
 * so this exact production logic can be driven against a real, headless
 * `@tiptap/core` Editor in composer-editor.test.ts — TipTap's `Editor` class
 * runs fully without a DOM when constructed without an `element` option (its
 * `view` getter falls back to a stub that still dispatches transactions and
 * emits `update`), so the boundary behaviour is provable without a browser.
 */
export function trackEmptyBoundary(onEmptyChange: (isEmpty: boolean) => void) {
  let wasEmpty = true;
  return ({ editor }: { editor: Pick<Editor, 'isEmpty'> }) => {
    const isEmptyNow = editor.isEmpty;
    if (isEmptyNow !== wasEmpty) {
      wasEmpty = isEmptyNow;
      onEmptyChange(isEmptyNow);
    }
  };
}

/**
 * Enter submits, Shift+Enter inserts a newline — the composer's only custom
 * keymap behaviour. Exported (same reasoning as `trackEmptyBoundary`) so
 * it's directly testable without a DOM: it never touches `view`, only the
 * event and the two live callbacks it's given.
 *
 * `isDisabled()` is a getter, not a boolean, because `editable={false}`
 * alone does NOT stop this from firing (fix round 1, Important 1):
 * `editable` only blocks ProseMirror from applying document-changing
 * transactions, it does not stop `handleKeyDown` from being invoked at all,
 * and `onSubmit()` is an imperative side effect this handler calls directly
 * — nothing about a disabled editor would otherwise stop a stray Enter from
 * submitting.
 */
export function createSubmitOnEnterHandler(
  onSubmit: () => void,
  isDisabled: () => boolean,
): (view: EditorView, event: KeyboardEvent) => boolean {
  return (_view, event) => {
    if (isDisabled()) return false;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
      return true;
    }
    return false;
  };
}

/**
 * Turn plain text into ProseMirror JSON paragraph nodes, one per `\n`-
 * separated line. Passed as JSON — never as a bare string — because
 * `editor.commands.setContent()` / `insertContent()` parse a bare string as
 * HTML (`elementFromString` -> `DOMParser`, verified in
 * `@tiptap/core/dist/index.js`'s `createNodeFromContent`), which would
 * corrupt literal `<`, `>`, `&` in prefilled plain text. This is what makes
 * `setContent` actually treat its input as plain text instead of merely
 * being named as if it does.
 */
function textToParagraphs(text: string): JSONContent[] {
  return text.split('\n').map((line) => ({
    type: 'paragraph',
    ...(line ? { content: [{ type: 'text', text: line }] } : {}),
  }));
}

/**
 * The DOM-free equivalent of an empty document. `editor.commands.clearContent()`
 * (fix round 1, Decision 3) calls `setContent('')` internally — a bare
 * string, always HTML-parsed, same as above. `clear()` uses this instead.
 */
const EMPTY_DOC: JSONContent = { type: 'doc', content: textToParagraphs('') };

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor({ placeholder, disabled, autoFocus, onSubmit, onEmptyChange }, ref) {
    // Mirrors use-composer-focus.ts's onTypeAheadRef: @tiptap/react only
    // resyncs `onUpdate`/other callback options when some OTHER option also
    // changed (it explicitly ignores their identity in its own option
    // comparison), so a fresh inline callback each render would otherwise go
    // stale. Applied to every value a stable, memoized-once closure below
    // needs to read fresh: onEmptyChange, onSubmit, disabled, placeholder.
    const onEmptyChangeRef = useRef(onEmptyChange);
    useEffect(() => {
      onEmptyChangeRef.current = onEmptyChange;
    }, [onEmptyChange]);

    const onSubmitRef = useRef(onSubmit);
    useEffect(() => {
      onSubmitRef.current = onSubmit;
    }, [onSubmit]);

    const disabledRef = useRef(disabled ?? false);
    useEffect(() => {
      disabledRef.current = disabled ?? false;
    }, [disabled]);

    const placeholderRef = useRef(placeholder);
    useEffect(() => {
      placeholderRef.current = placeholder;
    }, [placeholder]);

    const handleUpdate = useMemo(
      () => trackEmptyBoundary((isEmpty) => onEmptyChangeRef.current(isEmpty)),
      [],
    );

    const handleKeyDown = useMemo(
      () =>
        createSubmitOnEnterHandler(
          () => onSubmitRef.current(),
          () => disabledRef.current,
        ),
      [],
    );

    const editor = useEditor({
      immediatelyRender: false, // required: Next SSR
      autofocus: autoFocus,
      editable: !disabled,
      extensions: [...baseExtensions(() => placeholderRef.current), MentionNode],
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Message input',
          class: 'outline-none min-h-[3rem] max-h-[12.5rem] overflow-y-auto',
        },
        handleKeyDown,
      },
      onUpdate: handleUpdate,
    });

    // `editable` in the useEditor() options above is honoured ONLY at
    // construction (fix round 1, Important 1): @tiptap/react's own
    // per-render resync deliberately overwrites `editable` with the editor's
    // EXISTING value (`@tiptap/react/dist/index.js`:418-422,
    // `setOptions({ ...current, editable: this.editor.isEditable })`) and
    // never calls `setEditable` itself. `setEditable` is the only thing that
    // actually toggles it after mount.
    useEffect(() => {
      editor?.setEditable(!disabled);
    }, [editor, disabled]);

    // Forces the Placeholder plugin to recompute its decorations (fix round
    // 1, Important 2). `baseExtensions`'s `getPlaceholder` already reads
    // `placeholderRef.current` fresh on every recompute, but ProseMirror only
    // recomputes decorations on a view redraw — a ref mutation with no
    // dispatched transaction doesn't trigger one by itself. A no-op
    // transaction (`docChanged: false`) forces exactly that redraw without
    // touching the document, and does not fire `onUpdate` (its guard is
    // `transactions.some(tr => tr.docChanged)`), so this can never trip
    // trackEmptyBoundary.
    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr);
    }, [editor, placeholder]);

    useImperativeHandle(
      ref,
      (): ComposerEditorHandle => ({
        getContent: () =>
          editor ? serializeDocument(editor.state.doc) : { text: '', mentions: [] },
        setContent: (text, mode = 'replace') => {
          if (!editor) return;
          const paragraphs = textToParagraphs(text);
          if (mode === 'merge' && !editor.isEmpty) {
            editor.commands.insertContent([{ type: 'paragraph' }, ...paragraphs]);
          } else {
            editor.commands.setContent({ type: 'doc', content: paragraphs });
          }
          editor.commands.focus('end');
        },
        clear: () => editor?.commands.setContent(EMPTY_DOC),
        focus: () => editor?.commands.focus('end'),
        isEmpty: () => editor?.isEmpty ?? true,
        getElement: () => (editor && !editor.isDestroyed ? editor.view.dom : null),
      }),
      [editor],
    );

    return (
      <EditorContent
        editor={editor}
        className={cn('kortix-composer-editor w-full text-base sm:text-sm', disabled && 'opacity-50')}
      />
    );
  },
);
