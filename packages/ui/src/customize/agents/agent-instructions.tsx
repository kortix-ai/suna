'use client';

/**
 * The agent's instructions on the Overview, edited in place: the formatted
 * document is the editor. A person clicks into it and types, like a doc; the
 * Markdown file (`agents/<name>.md`) never shows its `**` or `##`. It is the
 * same editor as doc artifacts (`markdown/doc-editor`), so Kortix has one
 * document editor, and a file opened and saved unchanged stays byte for byte
 * the same (`doc-round-trip.test.ts`).
 *
 * Edits go to the page's draft on every change; the save bar, ⌘S and the
 * leave guard save them. A long document opens folded under a fade, and
 * clicking into it unfolds it. Escape leaves the editor.
 */

import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { SparkleIcon } from '@phosphor-icons/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { docExtensions } from '../../markdown/doc-editor/doc-extensions';
import { DocMenus } from '../../markdown/doc-editor/doc-menus';
import { htmlToMarkdown, markdownToHtml } from '../../markdown/doc-editor/markdown';
import { Button } from '../../primitives/button';
import { Skeleton } from '../../primitives/skeleton';

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function AgentInstructions({
  value,
  onChange,
  onAskMyKortix,
  autoFocus = false,
}: {
  /** The instructions as Markdown; null while a reader's source file loads. */
  value: string | null;
  /** Writes the draft. Without it the document is read-only. */
  onChange?: (next: string) => void;
  /** Opens a configure thread that asks My Kortix to edit the instructions. */
  onAskMyKortix?: () => void;
  /** Open unfolded with the cursor in it (the old `?tab=instructions` link). */
  autoFocus?: boolean;
}) {
  const t = useI18nTranslations('agentEditor.page');
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const editable = onChange !== undefined;
  const [unfolded, setUnfolded] = useState(autoFocus);
  // Taller than the fold: measured while folded, kept once unfolded.
  const [long, setLong] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  // The Markdown the editor last wrote. A value that differs came from
  // outside (Discard, a save's read-back) and reloads the document.
  const written = useRef(value);
  // The document as loaded: its source, and what the editor saves it as.
  // Saving the loaded document gives back the source, byte for byte.
  const loaded = useRef<{ source: string; saved: string | null }>({ source: value ?? '', saved: null });
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      autofocus: autoFocus ? 'start' : false,
      extensions: docExtensions({ editable, placeholder: () => tTabs('instructionsPlaceholder') }),
      content: value === null ? '' : markdownToHtml(value),
      editorProps: {
        attributes: { 'aria-label': t('instructions') },
        handleKeyDown: (view, event) => {
          if (event.key !== 'Escape') return false;
          (view.dom as HTMLElement).blur();
          return true;
        },
      },
      onCreate: ({ editor: e }) => {
        loaded.current = { source: value ?? '', saved: htmlToMarkdown(e.getHTML()) };
      },
      onFocus: () => setUnfolded(true),
      onUpdate: ({ editor: e }) => {
        // Only a person's edit writes the draft. The editor's own fix-ups on
        // load (a trailing paragraph after a list) are not an edit.
        if (!e.isFocused) return;
        const saved = htmlToMarkdown(e.getHTML());
        const next = saved === loaded.current.saved ? loaded.current.source : saved;
        written.current = next;
        latest.current?.(next);
      },
    },
    [editable, value === null],
  );

  useEffect(() => {
    if (!editor || value === null || value === written.current) return;
    written.current = value;
    editor.commands.setContent(markdownToHtml(value), { emitUpdate: false });
    loaded.current = { source: value, saved: htmlToMarkdown(editor.getHTML()) };
  }, [editor, value]);

  // Fold only a document taller than the fold.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || unfolded) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [editor, unfolded]);

  const words = wordCount(value ?? '');

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-foreground text-sm font-medium">
          {t('instructions')}
          {words > 0 ? (
            <span className="text-muted-foreground ml-2 font-normal tabular-nums">{t('words', { count: words })}</span>
          ) : null}
        </h2>
        {onAskMyKortix ? (
          <Button variant="ghost" size="sm" onClick={onAskMyKortix}>
            <SparkleIcon className="size-4" />
            {tTabs('askToEdit')}
          </Button>
        ) : null}
      </div>
      <div
        className={cn(
          'bg-background relative rounded-md border px-4 py-3',
          editable && 'hover:border-foreground/20 focus-within:border-foreground/20 cursor-text transition-colors',
        )}
      >
        <style>{ARTIFACT_DOC_CSS}</style>
        <div
          ref={frame}
          className={cn('kx-doc kx-doc-inline', !unfolded && 'max-h-96 overflow-hidden')}
        >
          {value === null || !editor ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : (
            <>
              {editable ? <DocMenus editor={editor} /> : null}
              <EditorContent editor={editor} />
            </>
          )}
        </div>
        {long && !unfolded ? (
          <div className="from-background absolute inset-x-0 bottom-0 flex h-24 items-end justify-center rounded-b-md bg-gradient-to-t to-transparent pb-3">
            <Button variant="secondary" size="sm" onClick={() => setUnfolded(true)}>
              {tI18nComplete.raw('textf5c9bd131486')}
            </Button>
          </div>
        ) : null}
      </div>
      {long && unfolded ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setUnfolded(false)}>
            {tI18nComplete.raw('text94ea9b1d33a0')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
