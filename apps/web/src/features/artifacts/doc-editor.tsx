'use client';

import { readArtifactFile, type ArtifactDetail } from '@kortix/sdk';
import { useArtifactMutations } from '@kortix/sdk/react';
import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@kortix/ui/tooltip';
import {
  CheckSquareIcon,
  CodeBlockIcon,
  CodeIcon,
  ImageIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  MinusIcon,
  PlusIcon,
  QuotesIcon,
  TableIcon,
  TextBIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TrashIcon,
  type Icon,
} from '@phosphor-icons/react';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { useTranslations } from '@/i18n/use-translations';

export type DocSaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

/** The doc stylesheet's colors from the app's theme, so the doc follows light and dark. */
const THEME_VARS = {
  '--kx-doc-bg': 'var(--background)',
  '--kx-doc-fg': 'var(--foreground)',
  '--kx-doc-muted': 'var(--muted-foreground)',
  '--kx-doc-border': 'var(--border)',
  '--kx-doc-subtle': 'var(--muted)',
  '--kx-doc-accent': 'var(--kortix-blue)',
} as CSSProperties;

const AUTOSAVE_MS = 1_200;

/** The stored page → the body the editor loads, with relative image paths made absolute against the page. */
function parseDoc(html: string, baseUrl: string): { body: string; images: Map<string, string> } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images = new Map<string, string>();
  doc.body.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src')!;
    if (/^([a-z]+:|\/\/|data:)/i.test(src)) return;
    const absolute = new URL(src, baseUrl).toString();
    images.set(absolute, src);
    img.setAttribute('src', absolute);
  });
  return { body: doc.body.innerHTML, images };
}

/** The editor's content → the stored page: a full HTML document titled by its first heading. */
function serializeDoc(editor: Editor, images: Map<string, string>, fallbackTitle: string): { html: string; title: string } {
  let body = editor.getHTML();
  for (const [absolute, relative] of images) body = body.split(absolute).join(relative);
  const firstHeading = editor.$node('heading')?.textContent.trim();
  const title = firstHeading || fallbackTitle;
  const escaped = title.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return { html: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escaped}</title></head>\n<body>\n${body}\n</body></html>\n`, title };
}

/**
 * A doc artifact, edited in place: the same stylesheet the published page uses,
 * Markdown shortcuts (`# `, `- `, `1. `, `[ ] `, `> `, ``` ```), a menu on
 * selected text, a `+` menu on an empty line, tables, task lists, links and
 * images. Changes save by themselves; saves within 10 minutes fold into one
 * version (`amend`).
 */
export function DocEditor({
  projectId,
  artifact,
  editable,
  onStatus,
}: {
  projectId: string;
  artifact: ArtifactDetail;
  editable: boolean;
  onStatus: (status: DocSaveStatus) => void;
}) {
  const t = useTranslations('artifacts');
  const { publish } = useArtifactMutations(projectId);
  const [loaded, setLoaded] = useState<{ body: string; images: Map<string, string> } | null>(null);
  const base = useRef(artifact.current_version);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<unknown> | null>(null);
  const stopped = useRef(false);
  const latest = useRef({ publish, onStatus, artifact });
  useEffect(() => {
    latest.current = { publish, onStatus, artifact };
  });

  useEffect(() => {
    let live = true;
    readArtifactFile(projectId, artifact.artifact_id, { version: artifact.version.version })
      .then((blob) => blob.text())
      .then((html) => live && setLoaded(parseDoc(html, artifact.version.view_url)))
      .catch((err: Error) => errorToast(err.message));
    return () => {
      live = false;
    };
    // One load per mount: the viewer remounts the editor for another version,
    // and our own saves (which move the version) must never reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (editor: Editor) => {
    if (stopped.current || !loaded) return;
    const { publish: run, onStatus: report, artifact: current } = latest.current;
    const { html, title } = serializeDoc(editor, loaded.images, current.title);
    report('saving');
    const attempt = run.mutateAsync({
      artifactId: current.artifact_id,
      base_version: base.current,
      amend: true,
      ...(title !== current.title ? { title } : {}),
      files: { 'index.html': { content: html } },
    });
    saving.current = attempt;
    try {
      const next = await attempt;
      base.current = next.current_version;
      report(timer.current ? 'unsaved' : 'saved');
    } catch (err) {
      const conflict = (err as { status?: number }).status === 409;
      if (conflict) stopped.current = true;
      report('error');
      errorToast(conflict ? t('conflict') : (err as Error).message);
    }
  };

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        StarterKit.configure({ link: { openOnClick: !editable, autolink: true, defaultProtocol: 'https' } }),
        TableKit.configure({ table: { resizable: false } }),
        Image,
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({
          placeholder: ({ node }) => (node.type.name === 'heading' ? t('placeholderHeading') : t('placeholder')),
        }),
      ],
      content: loaded?.body ?? '',
      onUpdate: ({ editor: e }) => {
        if (!editable) return;
        latest.current.onStatus('unsaved');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          void save(e);
        }, AUTOSAVE_MS);
      },
    },
    [loaded, editable],
  );

  // Save now on ⌘S, and before the page goes away.
  useEffect(() => {
    if (!editor || !editable) return;
    const flush = () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      void save(editor);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        flush();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (timer.current || saving.current) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editable]);

  return (
    <div className="kx-doc min-h-full" style={THEME_VARS}>
      <style>{ARTIFACT_DOC_CSS}</style>
      {!loaded || !editor ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-2/3" />
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
  );
}

function MenuButton({ icon: IconCmp, label, active, onClick }: { icon: Icon; label: string; active?: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className="hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-foreground text-muted-foreground grid size-7 place-items-center rounded-sm"
          data-active={active || undefined}
        >
          <IconCmp className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const MENU = 'bg-popover text-popover-foreground flex items-center gap-0.5 rounded-md border p-1 shadow-md';

function DocMenus({ editor }: { editor: Editor }) {
  const t = useTranslations('artifacts');
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      quote: e.isActive('blockquote'),
      table: e.isActive('table'),
    }),
  });
  const chain = () => editor.chain().focus();
  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt(t('linkPrompt'), previous ?? 'https://');
    if (url === null) return;
    if (url.trim() === '') chain().extendMarkRange('link').unsetLink().run();
    else chain().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  const addImage = () => {
    const url = window.prompt(t('imagePrompt'), 'https://');
    if (url?.trim()) chain().setImage({ src: url.trim() }).run();
  };

  return (
    <>
      <BubbleMenu editor={editor} options={{ placement: 'top' }} shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive('image')}>
        <div className={MENU}>
          <MenuButton icon={TextBIcon} label={t('bold')} active={state.bold} onClick={() => chain().toggleBold().run()} />
          <MenuButton icon={TextItalicIcon} label={t('italic')} active={state.italic} onClick={() => chain().toggleItalic().run()} />
          <MenuButton icon={TextStrikethroughIcon} label={t('strike')} active={state.strike} onClick={() => chain().toggleStrike().run()} />
          <MenuButton icon={CodeIcon} label={t('inlineCode')} active={state.code} onClick={() => chain().toggleCode().run()} />
          <MenuButton icon={LinkSimpleIcon} label={t('link')} active={state.link} onClick={setLink} />
          <span className="bg-border mx-0.5 h-5 w-px" />
          <MenuButton icon={TextHOneIcon} label={t('heading1')} active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()} />
          <MenuButton icon={TextHTwoIcon} label={t('heading2')} active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()} />
          <MenuButton icon={TextHThreeIcon} label={t('heading3')} active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()} />
          <MenuButton icon={QuotesIcon} label={t('quote')} active={state.quote} onClick={() => chain().toggleBlockquote().run()} />
          {state.table ? (
            <>
              <span className="bg-border mx-0.5 h-5 w-px" />
              <MenuButton icon={PlusIcon} label={t('addRow')} onClick={() => chain().addRowAfter().run()} />
              <MenuButton icon={ListBulletsIcon} label={t('addColumn')} onClick={() => chain().addColumnAfter().run()} />
              <MenuButton icon={MinusIcon} label={t('deleteRow')} onClick={() => chain().deleteRow().run()} />
              <MenuButton icon={TrashIcon} label={t('deleteTable')} onClick={() => chain().deleteTable().run()} />
            </>
          ) : null}
        </div>
      </BubbleMenu>
      <FloatingMenu editor={editor} options={{ placement: 'bottom-start', offset: 6 }}>
        <div className={MENU}>
          <MenuButton icon={TextHOneIcon} label={t('heading1')} onClick={() => chain().setHeading({ level: 1 }).run()} />
          <MenuButton icon={TextHTwoIcon} label={t('heading2')} onClick={() => chain().setHeading({ level: 2 }).run()} />
          <MenuButton icon={TextHThreeIcon} label={t('heading3')} onClick={() => chain().setHeading({ level: 3 }).run()} />
          <MenuButton icon={ListBulletsIcon} label={t('bulletList')} onClick={() => chain().toggleBulletList().run()} />
          <MenuButton icon={ListNumbersIcon} label={t('numberedList')} onClick={() => chain().toggleOrderedList().run()} />
          <MenuButton icon={CheckSquareIcon} label={t('taskList')} onClick={() => chain().toggleTaskList().run()} />
          <MenuButton icon={QuotesIcon} label={t('quote')} onClick={() => chain().toggleBlockquote().run()} />
          <MenuButton icon={CodeBlockIcon} label={t('codeBlock')} onClick={() => chain().toggleCodeBlock().run()} />
          <MenuButton icon={TableIcon} label={t('table')} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
          <MenuButton icon={ImageIcon} label={t('image')} onClick={addImage} />
          <MenuButton icon={MinusIcon} label={t('divider')} onClick={() => chain().setHorizontalRule().run()} />
        </div>
      </FloatingMenu>
    </>
  );
}
