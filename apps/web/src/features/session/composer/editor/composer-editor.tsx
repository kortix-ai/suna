'use client';

import { cn } from '@/lib/utils';
import type { Editor, JSONContent } from '@tiptap/core';
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

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor({ placeholder, disabled, autoFocus, onSubmit, onEmptyChange }, ref) {
    // Mirrors use-composer-focus.ts's onTypeAheadRef: @tiptap/react only
    // resyncs `onUpdate` when some OTHER option also changed (it explicitly
    // ignores onUpdate identity in its own option comparison), so a fresh
    // inline callback each render would otherwise go stale.
    const onEmptyChangeRef = useRef(onEmptyChange);
    useEffect(() => {
      onEmptyChangeRef.current = onEmptyChange;
    }, [onEmptyChange]);

    const handleUpdate = useMemo(
      () => trackEmptyBoundary((isEmpty) => onEmptyChangeRef.current(isEmpty)),
      [],
    );

    const editor = useEditor({
      immediatelyRender: false, // required: Next SSR
      autofocus: autoFocus,
      editable: !disabled,
      extensions: [...baseExtensions(placeholder), MentionNode],
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Message input',
          class: 'outline-none min-h-[3rem] max-h-[12.5rem] overflow-y-auto',
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
            return true;
          }
          return false;
        },
      },
      onUpdate: handleUpdate,
    });

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
        clear: () => editor?.commands.clearContent(),
        focus: () => editor?.commands.focus('end'),
        isEmpty: () => editor?.isEmpty ?? true,
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
