'use client';

import { getArtifact, getLinkPreview, readArtifactFile, type ArtifactDetail } from '@kortix/sdk';
import { useArtifactMutations, useArtifactText } from '@kortix/sdk/react';
import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import Loading from '@kortix/ui/loading';
import { MENU_PANEL_STATIC, menuRow } from '@kortix/ui/menu-recipe';
import { dismissToast, errorToast } from '@kortix/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@kortix/ui/tooltip';
import {
  CardsIcon,
  CodeIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  MinusIcon,
  PlusIcon,
  QuotesIcon,
  TextBIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TrashIcon,
  type Icon,
} from '@phosphor-icons/react';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { createDocSaver, pendingSave, type DocSaveStatus, type DocSaver, type Known } from './doc-autosave';
import { LinkEmbed, canEmbed, fetchEmbed } from './doc-embed';
import { DocCodeBlock, DocImage, Video, fileBase64, isMedia, mediaPath, mediaUrls, tooLarge } from './doc-media';
import { SlashCommand, SlashMenu, type SlashState } from './doc-slash-menu';
import { htmlToMarkdown, markdownToHtml } from './markdown';

import { useTranslations } from '@/i18n/use-translations';

export type { DocSaveStatus };

const isConflict = (err: unknown) => (err as { status?: number }).status === 409 && (err as { code?: string }).code === 'version_conflict';

/**
 * A doc artifact, edited in place: its Markdown file in Files, shown with the
 * same stylesheet the published page uses. Markdown shortcuts (`# `, `- `,
 * `1. `, `[ ] `, `> `, ``` ```), a menu on selected text, a `/` block menu,
 * tables, task lists, links, images, and GitHub or Linear links as cards
 * (a pasted one offers the card).
 *
 * Changes save themselves back to the file; each save is a commit of the Files
 * volume (`doc-autosave.ts` has the rules).
 */
export function DocEditor({
  projectId,
  artifact,
  editable,
  onStatus,
  onReload,
}: {
  projectId: string;
  artifact: ArtifactDetail;
  editable: boolean;
  onStatus: (status: DocSaveStatus) => void;
  /** Open the doc again at its current version (the conflict's Reload). */
  onReload: () => void;
}) {
  const t = useTranslations('artifacts');
  const { save: saveMutation } = useArtifactMutations(projectId);
  const [loaded, setLoaded] = useState<{ html: string; start: Known } | null>(null);
  const saver = useRef<DocSaver | null>(null);
  const latest = useRef({ save: saveMutation, onStatus, onReload, artifact, t });
  useEffect(() => {
    latest.current = { save: saveMutation, onStatus, onReload, artifact, t };
  });
  // Relative media paths in the Markdown ↔ absolute URLs in the editor (the page URL of this version).
  const [media] = useState(() => mediaUrls(artifact.version.view_url));
  /** Single-file docs serve only themselves: their media must be absolute URLs. */
  const holdsMedia = !artifact.path.endsWith(`/${artifact.entry}`);

  // A save from a closed editor of this doc still on its way: wait for it (undefined), then open on it.
  const [handoff, setHandoff] = useState<Known | null | undefined>(() => (pendingSave(artifact.artifact_id) ? undefined : null));
  useEffect(() => {
    const pending = pendingSave(artifact.artifact_id);
    if (!pending) return;
    let live = true;
    void pending.then((result) => live && setHandoff(result));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Usually already in the cache (prefetched by the project preloader or a hover).
  // Pinned to the version opened: our own saves move `entry_version` and must not refetch.
  const [opened] = useState(artifact);
  const text = useArtifactText(projectId, handoff === null ? opened : null);
  const start: Known | null = handoff ?? (handoff === null && text.data !== undefined ? { version: opened.entry_version, text: text.data } : null);
  if (loaded === null && start) setLoaded({ html: media.resolveHtml(markdownToHtml(start.text)), start });
  useEffect(() => {
    if (text.error) errorToast(text.error.message);
  }, [text.error]);

  const markdownOf = (editor: Editor) => htmlToMarkdown(media.restore(editor.getHTML()));
  const readNow = async (current: ArtifactDetail): Promise<Known> => {
    const [detail, file] = await Promise.all([getArtifact(projectId, current.artifact_id), readArtifactFile(projectId, current.artifact_id)]);
    return { version: detail.entry_version, text: await file.text() };
  };

  const showConflict = () => {
    const { t: t, artifact: current } = latest.current;
    errorToast(t('conflict'), {
      id: `artifact-conflict-${current.artifact_id}`,
      duration: Infinity,
      actions: [
        { label: t('conflictReload'), onClick: () => latest.current.onReload() },
        { label: t('conflictKeepMine'), onClick: () => saver.current?.keepMine() },
      ],
    });
  };

  /**
   * Pasted, dropped or picked images and videos: shown at once from a local
   * URL with an "Uploading…" chip, written next to the doc in Files
   * (`media/…`), then pointed at that file. A failed upload removes it.
   */
  const upload = async (editor: Editor, files: File[], pos?: number) => {
    const { save: run, onStatus: report, artifact: current } = latest.current;
    const picked = files.flatMap((file) => {
      const kind = isMedia(file);
      return kind ? [{ file, kind }] : [];
    });
    if (!picked.length) return;
    if (!holdsMedia) return errorToast(t('mediaSingleFile'));
    const placed = picked.flatMap(({ file, kind }) => {
      if (!tooLarge(file)) return [{ file, kind, local: URL.createObjectURL(file) }];
      errorToast(t('mediaTooLarge'));
      return [];
    });
    if (!placed.length) return;
    editor
      .chain()
      .focus()
      .insertContentAt(pos ?? editor.state.selection.to, placed.map(({ kind, local }) => ({ type: kind, attrs: { src: local, uploading: true } })))
      .run();
    for (const { file, kind, local } of placed) {
      const path = mediaPath(file);
      report('saving');
      let src: string | null = null;
      try {
        await run.mutateAsync({ artifactId: current.artifact_id, files: { [path]: { content_base64: await fileBase64(file) } } });
        src = media.absolute(path);
        // Swap to the uploaded file once it has loaded, so the picture does not blink.
        if (kind === 'image') await preload(src);
      } catch {
        // The API client toasts the error; the doc's own text is unaffected.
        report(saver.current?.busy() ? 'unsaved' : 'saved');
      }
      if (!editor.isDestroyed) replaceMedia(editor, local, src);
      URL.revokeObjectURL(local);
    }
  };
  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  });

  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashKeys = useRef<(event: KeyboardEvent) => boolean>(() => false);
  /** A GitHub or Linear link just pasted: the offer to show it as a card. */
  const [offer, setOffer] = useState<Offer | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        StarterKit.configure({ codeBlock: false, link: { openOnClick: !editable, autolink: true, defaultProtocol: 'https' } }),
        DocCodeBlock,
        TableKit.configure({ table: { resizable: false } }),
        DocImage,
        Video,
        TaskList,
        TaskItem.configure({ nested: true }),
        LinkEmbed,
        SlashCommand.configure({ onChange: setSlash, onKey: (event) => slashKeys.current(event) }),
        Placeholder.configure({
          // None in a code block: it would sit on the block's language caption.
          placeholder: ({ node }) =>
            node.type.name === 'codeBlock' ? '' : node.type.name === 'heading' ? t('placeholderHeading') : t('placeholder'),
        }),
      ],
      content: loaded?.html ?? '',
      editorProps: {
        handlePaste: (view, event) => {
          const ed = editorRef.current;
          if (!editable || !ed) return false;
          const files = Array.from(event.clipboardData?.files ?? []).filter(isMedia);
          if (files.length) {
            void uploadRef.current(ed, files);
            return true;
          }
          // A lone link on an empty selection: paste it as a link, then offer the card.
          const href = event.clipboardData?.getData('text/plain').trim() ?? '';
          const { selection } = view.state;
          if (!canEmbed(href) || /\s/.test(href) || !selection.empty || selection.$from.parent.type.spec.code) return false;
          ed.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
          setOffer({ from: selection.from, to: selection.from + href.length, href });
          return true;
        },
        handleDrop: (view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter(isMedia);
          if (!editable || !files.length) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          const ed = editorRef.current;
          if (ed) void uploadRef.current(ed, files, at);
          return true;
        },
      },
      onUpdate: () => {
        if (editable) saver.current?.edited();
      },
    },
    [loaded, editable],
  );
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // The file moved (an agent wrote it, the artifact says so): an editor with nothing unsaved shows the new text.
  const fileVersion = artifact.entry_version;
  useEffect(() => {
    const docSaver = saver.current;
    if (!editor || !docSaver) return;
    let live = true;
    void docSaver.refresh(fileVersion).then((now) => {
      if (!live || !now || editor.isDestroyed) return;
      editor.commands.setContent(media.resolveHtml(markdownToHtml(now.text)), { emitUpdate: false });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileVersion]);

  // One saver per editor; save now on ⌘S, warn before the page goes away with changes not in the file.
  useEffect(() => {
    if (!editor || !editable || !loaded) return;
    const current = latest.current.artifact;
    const docSaver = createDocSaver(loaded.start, {
      artifactId: current.artifact_id,
      write: async (markdown, base) => {
        const next = await latest.current.save.mutateAsync({
          artifactId: current.artifact_id,
          ...(base ? { base_version: base } : {}),
          files: { [current.entry]: { content: markdown } },
        });
        return next.entry_version;
      },
      read: () => readNow(current),
      text: () => markdownOf(editor),
      onStatus: (status) => latest.current.onStatus(status),
      onConflict: showConflict,
      isConflict,
    });
    saver.current = docSaver;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        docSaver.flush();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (docSaver.busy()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
      const conflictToastId = `artifact-conflict-${current.artifact_id}`;
      dismissToast(conflictToastId);
      docSaver.close();
      if (saver.current === docSaver) saver.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editable, loaded]);

  return (
    <div className="kx-doc min-h-full">
      <style>{ARTIFACT_DOC_CSS}</style>
      {loaded === null || !editor ? (
        // One quiet spinner while the text loads (usually cached: no wait at all).
        <div className="grid min-h-60 place-items-center">
          <Loading className="size-4" />
        </div>
      ) : (
        <>
          {editable ? <DocMenus editor={editor} /> : null}
          {editable && slash ? <SlashMenu editor={editor} state={slash} keysRef={slashKeys} onPickMedia={() => picker.current?.click()} /> : null}
          {editable && offer ? <EmbedOffer projectId={projectId} editor={editor} offer={offer} onClose={() => setOffer(null)} /> : null}
          <EditorContent editor={editor} />
          <input
            ref={picker}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              void upload(editor, Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </>
      )}
    </div>
  );
}

/** Resolves when the image at `src` has loaded or failed (5 s at most). */
function preload(src: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new window.Image();
    const done = () => resolve();
    img.onload = done;
    img.onerror = done;
    window.setTimeout(done, 5_000);
    img.src = src;
  });
}

/** The uploading media at `local`: pointed at its uploaded `src`, or removed (null). */
function replaceMedia(editor: Editor, local: string, src: string | null) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.attrs.src === local) at = pos;
  });
  if (at < 0) return;
  const node = editor.state.doc.nodeAt(at)!;
  const tr = src ? editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, src, uploading: false }) : editor.state.tr.delete(at, at + node.nodeSize);
  editor.view.dispatch(tr);
}

type Offer = { from: number; to: number; href: string };

/**
 * Under a pasted link: keep it as a link, or show it as a card. ↑ ↓ move
 * between the two, Enter picks, Escape keeps the link; those keys belong to
 * the menu while it is open (the caret stays put). Typing, clicking elsewhere
 * or scrolling keeps the link.
 */
function EmbedOffer({ projectId, editor, offer, onClose }: { projectId: string; editor: Editor; offer: Offer; onClose: () => void }) {
  const t = useTranslations('artifacts');
  const [loading, setLoading] = useState(false);
  // 0: Keep as link, 1: Show embed (the default, the reason the menu opened).
  const [active, setActive] = useState(1);
  const activeRef = useRef(1);
  const choose = (i: number) => {
    activeRef.current = i;
    setActive(i);
  };
  const close = useRef(onClose);
  const pick = useRef<(choice: number) => void>(() => {});
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; selection: { from: number } } }) => {
      if (transaction.docChanged || transaction.selection.from !== offer.to) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const own = (run: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') own(() => choose(activeRef.current === 0 ? 1 : 0));
      else if (e.key === 'Enter') own(() => pick.current(activeRef.current));
      else if (e.key === 'Escape') own(() => close.current());
    };
    const onScroll = () => close.current();
    editor.on('transaction', onTransaction);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      editor.off('transaction', onTransaction);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [editor, offer]);

  const embed = async () => {
    setLoading(true);
    const meta = await fetchEmbed(offer.href, (url) => getLinkPreview(projectId, url));
    const { doc } = editor.state;
    // The link must still be where it was pasted.
    if (meta && offer.to <= doc.content.size && doc.textBetween(offer.from, offer.to) === offer.href) {
      const $from = doc.resolve(offer.from);
      // A top-level paragraph that holds only the link becomes the card; otherwise the card splits it
      // (a list item must start with a paragraph).
      const alone = $from.depth === 1 && $from.parent.type.name === 'paragraph' && $from.parent.textContent.trim() === offer.href;
      const range = alone ? { from: $from.before(), to: $from.after() } : { from: offer.from, to: offer.to };
      editor.chain().focus().insertContentAt(range, { type: 'linkEmbed', attrs: meta }).run();
    }
    close.current();
  };
  useEffect(() => {
    close.current = onClose;
    pick.current = (choice) => (choice === 0 ? onClose() : void embed());
  });

  let at: { left: number; bottom: number };
  try {
    at = editor.view.coordsAtPos(offer.to);
  } catch {
    return null;
  }
  return createPortal(
    <div
      role="menu"
      aria-label={t('embedOffer')}
      style={{ top: at.bottom + 6, left: at.left }}
      onMouseDown={(e) => e.preventDefault()}
      className={`${MENU_PANEL_STATIC} fixed z-50 w-48`}
    >
      <button
        type="button"
        role="menuitem"
        data-highlighted={active === 0 ? '' : undefined}
        onMouseMove={() => choose(0)}
        className={menuRow('sm', 'default')}
        onClick={onClose}
      >
        <LinkSimpleIcon className="text-muted-foreground" /> {t('keepAsLink')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-highlighted={active === 1 ? '' : undefined}
        onMouseMove={() => choose(1)}
        className={menuRow('sm', 'default')}
        disabled={loading}
        aria-busy={loading}
        onClick={() => void embed()}
      >
        {loading ? <Loading className="size-4" /> : <CardsIcon className="text-muted-foreground" />} {t('showEmbed')}
      </button>
    </div>,
    document.body,
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
  return (
    <>
      <BubbleMenu editor={editor} options={{ placement: 'top' }} shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive('image') && !e.isActive('video')}>
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
    </>
  );
}
