'use client';

import type { ArtifactDetail } from '@kortix/sdk';
import { useArtifactMutations, useArtifactText } from '@kortix/sdk/react';
import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { docExtensions } from '@kortix/ui/markdown/doc-editor/doc-extensions';
import { DocMenus } from '@kortix/ui/markdown/doc-editor/doc-menus';
import { htmlToMarkdown, markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

import { fileBase64, isMedia, mediaPath, mediaUrls, tooLarge } from './doc-media';

import { useTranslations } from '@/i18n/use-translations';

export type DocSaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

/** The doc stylesheet's colors from the app's theme, so the doc follows light and dark. */

const AUTOSAVE_MS = 2_000;

/**
 * A doc artifact, edited in place: its Markdown file in Files, shown with the
 * same stylesheet the published page uses. Markdown shortcuts (`# `, `- `,
 * `1. `, `[ ] `, `> `, ``` ```), a menu on selected text, a `+` menu on an
 * empty line, tables, task lists, links and images. Changes save themselves
 * back to the file; each save is a commit of the Files volume.
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
  const { save: saveMutation } = useArtifactMutations(projectId);
  const [loaded, setLoaded] = useState<string | null>(null);
  const base = useRef(artifact.entry_version);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<unknown> | null>(null);
  const stopped = useRef(false);
  const latest = useRef({ save: saveMutation, onStatus, artifact });
  useEffect(() => {
    latest.current = { save: saveMutation, onStatus, artifact };
  });
  // Relative media paths in the Markdown ↔ absolute URLs in the editor (the page URL of this version).
  const [media] = useState(() => mediaUrls(artifact.version.view_url));
  /** Single-file docs serve only themselves: their media must be absolute URLs. */
  const holdsMedia = !artifact.path.endsWith(`/${artifact.entry}`);

  // Usually already in the cache (prefetched by the project preloader or a hover).
  // Pinned to the version opened: our own saves move `entry_version` and must not refetch.
  const [opened] = useState(artifact);
  const text = useArtifactText(projectId, opened);
  if (loaded === null && text.data !== undefined) setLoaded(media.resolveHtml(markdownToHtml(text.data)));
  // One load per mount: our own saves (which move the version) never reload the editor.
  useEffect(() => {
    if (text.error) errorToast(text.error.message);
  }, [text.error]);

  const save = async (editor: Editor) => {
    if (stopped.current || loaded === null) return;
    const { save: run, onStatus: report, artifact: current } = latest.current;
    report('saving');
    const attempt = run.mutateAsync({
      artifactId: current.artifact_id,
      ...(base.current ? { base_version: base.current } : {}),
      files: { [current.entry]: { content: htmlToMarkdown(media.restore(editor.getHTML())) } },
    });
    saving.current = attempt;
    try {
      const next = await attempt;
      base.current = next.entry_version;
      report(timer.current ? 'unsaved' : 'saved');
    } catch (err) {
      const conflict = (err as { status?: number }).status === 409;
      if (conflict) stopped.current = true;
      report('error');
      errorToast(conflict ? t('conflict') : (err as Error).message);
    } finally {
      saving.current = null;
    }
  };

  /** Pasted, dropped or picked images and videos: written next to the doc in Files (`media/…`), then placed in it. */
  const upload = async (editor: Editor, files: File[], pos?: number) => {
    const { save: run, onStatus: report, artifact: current } = latest.current;
    for (const file of files) {
      const kind = isMedia(file);
      if (!kind) continue;
      if (!holdsMedia) return errorToast(t('mediaSingleFile'));
      if (tooLarge(file)) {
        errorToast(t('mediaTooLarge'));
        continue;
      }
      const path = mediaPath(file);
      report('saving');
      try {
        await run.mutateAsync({ artifactId: current.artifact_id, files: { [path]: { content_base64: await fileBase64(file) } } });
      } catch (err) {
        report('error');
        errorToast((err as Error).message);
        continue;
      }
      const node = { type: kind, attrs: { src: media.absolute(path) } };
      editor.chain().focus().insertContentAt(pos ?? editor.state.selection.to, node).run();
    }
  };
  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  });

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: docExtensions({
        editable,
        placeholder: (node) => (node.type.name === 'heading' ? t('placeholderHeading') : t('placeholder')),
      }),
      content: loaded ?? '',
      editorProps: {
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter(isMedia);
          if (!editable || !files.length) return false;
          const ed = editorRef.current;
          if (ed) void uploadRef.current(ed, files);
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
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

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
    <div className="kx-doc min-h-full">
      <style>{ARTIFACT_DOC_CSS}</style>
      {loaded === null || !editor ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : (
        <>
          {editable ? <DocMenus editor={editor} onPickMedia={(files) => void upload(editor, files)} /> : null}
          <EditorContent editor={editor} />
        </>
      )}
    </div>
  );
}
