'use client';

import { getArtifact, readArtifactFile, type ArtifactDetail } from '@kortix/sdk';
import { useArtifactMutations, useArtifactText } from '@kortix/sdk/react';
import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { docExtensions } from '@kortix/ui/markdown/doc-editor/doc-extensions';
import { DocMenus } from '@kortix/ui/markdown/doc-editor/doc-menus';
import { htmlToMarkdown, markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { dismissToast, errorToast } from '@kortix/ui/toast';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

import { createDocSaver, pendingSave, type DocSaveStatus, type DocSaver, type Known } from './doc-autosave';
import { fileBase64, isMedia, mediaPath, mediaUrls, tooLarge } from './doc-media';

import { useTranslations } from '@/i18n/use-translations';

export type { DocSaveStatus };

const isConflict = (err: unknown) => (err as { status?: number }).status === 409 && (err as { code?: string }).code === 'version_conflict';

/**
 * A doc artifact, edited in place: its Markdown file in Files, shown with the
 * same stylesheet the published page uses. Markdown shortcuts (`# `, `- `,
 * `1. `, `[ ] `, `> `, ``` ```), a menu on selected text, a `+` menu on an
 * empty line, tables, task lists, links and images.
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
      } catch {
        // The API client toasts the error; the doc's own text is unaffected.
        report(saver.current?.busy() ? 'unsaved' : 'saved');
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
      content: loaded?.html ?? '',
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
