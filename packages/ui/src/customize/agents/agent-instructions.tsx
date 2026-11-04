'use client';

/**
 * The agent's instructions on the Overview, edited in place: the formatted
 * document is the editor. A person clicks into it and types, like a doc; the
 * Markdown file (`agents/<name>.md`) never shows its `**` or `##`. It is the
 * same editor as doc artifacts (`markdown/doc-editor`), so Kortix has one
 * document editor, and a file opened and saved unchanged stays byte for byte
 * the same (`doc-round-trip.test.ts`).
 *
 * An agent file may open with a YAML frontmatter block (`---` … `---`: an
 * OpenCode-style `description`, `mode`, `permission`). The editor never sees
 * it: Markdown would read its `#` comments as headings. The block shows as a
 * read-only metadata card above the document, and every edit writes it back
 * in front of the body byte for byte (`splitFrontmatter`).
 *
 * Edits go to the page's draft on every change; the save bar, ⌘S and the
 * leave guard save them. A long document opens folded under a fade that runs
 * to the block's bottom edge; Show more or a click into it unfolds it, for
 * good. Escape leaves the editor.
 */

import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { CaretDownIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { docExtensions } from '../../markdown/doc-editor/doc-extensions';
import { DocMenus } from '../../markdown/doc-editor/doc-menus';
import { htmlToMarkdown, markdownToHtml } from '../../markdown/doc-editor/markdown';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import Hint from '../../primitives/hint';
import { Skeleton } from '../../primitives/skeleton';
import { MarkdownFrontmatterCard, parseFrontmatter } from '../../markdown/markdown-frontmatter';

/** A leading `---` … `---` block, with the line break that closes it. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Splits an agent file into its frontmatter (`head`, exact bytes, '' when
 * there is none) and the Markdown body. `head + body` is always the input.
 */
export function splitFrontmatter(text: string): { head: string; body: string } {
  const match = text.match(FRONTMATTER);
  return match ? { head: match[0], body: text.slice(match[0].length) } : { head: '', body: text };
}

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
  // The editor holds the body only; the frontmatter rides along unchanged.
  const split = value === null ? null : splitFrontmatter(value);
  const body = split?.body ?? null;
  const headText = split?.head ?? '';
  const head = useRef(headText);
  useEffect(() => {
    head.current = headText;
  }, [headText]);
  const meta = split?.head ? parseFrontmatter(split.head).frontmatter : null;
  const [unfolded, setUnfolded] = useState(autoFocus);
  // Taller than the fold: measured while folded, kept once unfolded.
  const [long, setLong] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  // The Markdown the editor last wrote. A value that differs came from
  // outside (Discard, a save's read-back) and reloads the document.
  const written = useRef(body);
  // The document as loaded: its source, and what the editor saves it as.
  // Saving the loaded document gives back the source, byte for byte.
  const loaded = useRef<{ source: string; saved: string | null }>({ source: body ?? '', saved: null });
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
      content: body === null ? '' : markdownToHtml(body),
      editorProps: {
        attributes: { 'aria-label': t('instructions') },
        handleKeyDown: (view, event) => {
          if (event.key !== 'Escape') return false;
          (view.dom as HTMLElement).blur();
          return true;
        },
      },
      onCreate: ({ editor: e }) => {
        loaded.current = { source: body ?? '', saved: htmlToMarkdown(e.getHTML()) };
      },
      onFocus: () => setUnfolded(true),
      onUpdate: ({ editor: e }) => {
        // Only a person's edit writes the draft. The editor's own fix-ups on
        // load (a trailing paragraph after a list) are not an edit.
        if (!e.isFocused) return;
        const saved = htmlToMarkdown(e.getHTML());
        const next = saved === loaded.current.saved ? loaded.current.source : saved;
        written.current = next;
        latest.current?.(head.current + next);
      },
    },
    [editable, value === null],
  );

  useEffect(() => {
    if (!editor || body === null || body === written.current) return;
    written.current = body;
    editor.commands.setContent(markdownToHtml(body), { emitUpdate: false });
    loaded.current = { source: body, saved: htmlToMarkdown(editor.getHTML()) };
  }, [editor, body]);

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

  const [confirmEdit, setConfirmEdit] = useState(false);
  const words = wordCount(body ?? '');
  const folded = long && !unfolded;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-muted-foreground text-sm font-medium">
          {t('instructions')}
          {words > 0 ? (
            <span className="text-muted-foreground ml-2 font-normal tabular-nums">{t('words', { count: words })}</span>
          ) : null}
        </h2>
      </div>
      <div
        className={cn(
          // A filled block, no border. Folded, it has no bottom inset: the fade meets the edge.
          'bg-popover relative overflow-hidden rounded-lg px-5 pt-4',
          // Room for the pencil in the top-right corner.
          onAskMyKortix && 'pr-12',
          folded ? 'pb-0' : 'pb-4',
          editable && 'cursor-text',
        )}
      >
        <style>{ARTIFACT_DOC_CSS}</style>
        {onAskMyKortix ? (
          // The Description box's pencil, in the same corner. My Kortix edits the
          // instructions in a new session, so a click asks first.
          <Hint label={tTabs('askToEdit')} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={tTabs('askToEdit')}
              onClick={() => setConfirmEdit(true)}
              className="text-muted-foreground hover:text-foreground absolute top-3 right-3 z-10"
            >
              <PencilSimpleIcon className="size-3.5" />
            </Button>
          </Hint>
        ) : null}
        {meta ? <MarkdownFrontmatterCard data={meta} className="mb-4" /> : null}
        <div
          ref={frame}
          className={cn('kx-doc kx-doc-inline', !unfolded && 'max-h-80 overflow-hidden')}
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
        {folded ? (
          <div className="to-popover absolute inset-x-0 bottom-0 flex h-32 items-end justify-center bg-gradient-to-b from-transparent to-80% pb-4">
            <Button variant="secondary" size="sm" onClick={() => setUnfolded(true)}>
              {tI18nComplete.raw('textf5c9bd131486')}
              <CaretDownIcon className="size-3" />
            </Button>
          </div>
        ) : null}
      </div>
      {onAskMyKortix ? (
        <ConfirmDialog
          open={confirmEdit}
          onOpenChange={setConfirmEdit}
          title={tTabs('editInstructionsConfirmTitle')}
          description={tTabs('editInstructionsConfirmBody')}
          confirmLabel={tTabs('askToEdit')}
          onConfirm={() => {
            setConfirmEdit(false);
            onAskMyKortix();
          }}
        />
      ) : null}
    </section>
  );
}
