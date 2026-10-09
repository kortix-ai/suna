'use client';

import { useTranslations } from '@/i18n/use-translations';

import { errorToast, successToast } from '@/components/ui/toast';
import { useHeicBlob } from '@/hooks/use-heic-url';
import { isHeicFile } from '@/lib/utils/heic-convert';
import { findDiagnosticsForFile, useDiagnosticsStore } from '@/stores/diagnostics-store';
import { isSandboxNotReadyError } from '@kortix/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileSource } from './file-source';
import { getFileCategory, getLanguageFromExt, type FileCategory } from './preview-policy';
import { usePreviewFit } from './preview-fit';
import { useContentRevision } from './use-content-revision';
import type { FileContentRendererProps } from './file-content-renderer';

/** Categories that need a blob fetched via readFileAsBlob */
const BLOB_CATEGORIES = ['docx', 'video', 'audio', 'pptx', 'zip'] as const;
type BlobCategory = (typeof BLOB_CATEGORIES)[number];

function isImageMime(mimeType?: string): boolean {
  return !!mimeType && mimeType.startsWith('image/');
}

function isBlobCategory(cat: FileCategory): cat is BlobCategory {
  return (BLOB_CATEGORIES as readonly string[]).includes(cat);
}

/** Detect error messages that indicate "file not found" vs other failures. */
function isNotFoundError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('no such file') ||
    lower.includes('enoent') ||
    lower.includes('does not exist') ||
    lower.includes('path not found')
  );
}


export function useFileContentState({
  filePath,
  onUnsavedChange,
  onSaved,
  readOnly,
  markdownPreview,
  onMarkdownPreviewChange,
  onStatusChange,
 }: Pick<FileContentRendererProps, 'filePath' | 'onUnsavedChange' | 'onSaved' | 'readOnly' | 'markdownPreview' | 'onMarkdownPreviewChange' | 'onStatusChange'> & { readOnly: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const fileName = filePath.split('/').pop() || '';
  const isHeicImage = isHeicFile(fileName);

  // `null` outside a <PreviewFitProvider>. Used for one thing only: telling a
  // ratio-fitting surface that an `image` produced nothing to render, in which
  // case no ImageRenderer is ever mounted and no renderer is left to say so
  // itself. Every other failure is reported by the renderer that hit it.
  const previewFit = usePreviewFit();

  // Data access is supplied by the surface (live workspace vs. project git-ref)
  // via <FileSourceProvider>, so this renderer stays presentation-only.
  const source = useFileSource();
  const { useFileContent, useBinaryBlob, Breadcrumbs } = source;

  // Text content (for code/text files, CSV, non-HEIC images).
  // HEIC files are loaded exclusively via the blob pipeline — the text/base64
  // endpoint often returns 500 for HEIC because the server can't encode them.
  // A zip is fetched ONCE, as bytes. Left on the text path as well it would
  // also be pulled as base64 through /file/content — a second full download of
  // an archive that is often the largest thing in the workspace, for a string
  // no branch below reads (`isContentReady` resolves off the blob for every
  // BLOB_CATEGORY). Keyed off the filename alone, so it cannot depend on the
  // response it is disabling.
  const isZipArchive = getFileCategory(fileName) === 'zip';
  const {
    data: fileContent,
    isLoading,
    error,
    refetch,
    dataUpdatedAt,
  } = useFileContent(isHeicImage || isZipArchive ? null : filePath);

  // The agent's turn end refetches this file. The xlsx and sqlite renderers
  // read their own bytes, so they remount only when the content really
  // changed (structural sharing keeps the reference otherwise). The HTML frame
  // reloads on every refetch: its stylesheets can change while its markup
  // does not. Neither moves on the first load.
  const contentRevision = useContentRevision(fileContent);
  const fetchRevision = useContentRevision(dataUpdatedAt || undefined);

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  // Tracks the latest editor content so we can save from the header button.
  const latestContentRef = useRef<string>('');
  // Bumped on discard to force-remount the CodeEditor and reset its internal state.
  const [discardKey, setDiscardKey] = useState(0);

  const language = getLanguageFromExt(fileName);
  const fileCategory = getFileCategory(fileName, fileContent?.mimeType);
  const isMarkdownFile = language === 'markdown';
  // `.mmd` / `.mermaid` share the markdown Preview/Source toggle and its state:
  // both are text files whose rendered form is the default view.
  const isMermaidFile = language === 'mermaid';
  const hasPreviewToggle = isMarkdownFile || isMermaidFile;
  const isJsonFile = language === 'json';
  // The rendered HTML frame is served by a session's static file server; a
  // bytes-only source has none, so its HTML opens as source.
  const isHtmlFile = fileCategory === 'html' && !source.bytesOnly;
  // Markdown defaults to rendered preview (UnifiedMarkdown). Users can flip to
  // source/edit via the eye/code toggle in the header. The state is optionally
  // controlled by the caller (file-preview-modal lifts it into its own chrome).
  const [internalMarkdownPreview, setInternalMarkdownPreview] = useState(true);
  const isMarkdownPreview = markdownPreview ?? internalMarkdownPreview;
  const setIsMarkdownPreview = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const resolved = typeof next === 'function' ? next(isMarkdownPreview) : next;
      if (onMarkdownPreviewChange) onMarkdownPreviewChange(resolved);
      if (markdownPreview === undefined) setInternalMarkdownPreview(resolved);
    },
    [isMarkdownPreview, markdownPreview, onMarkdownPreviewChange],
  );
  const [isJsonTreeView, setIsJsonTreeView] = useState(false);
  // HTML files default to rendered preview mode
  const [isHtmlPreview, setIsHtmlPreview] = useState(true);

  const saveFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the transient "saved" flash timer if we unmount before it fires.
  useEffect(
    () => () => {
      if (saveFlashTimerRef.current) clearTimeout(saveFlashTimerRef.current);
    },
    [],
  );

  // LSP diagnostics for this file from the global diagnostics store
  // Uses suffix-matching because LSP stores absolute paths but we use relative paths
  const diagByFile = useDiagnosticsStore((s) => s.byFile);
  const fileDiagnostics = useMemo(
    () => findDiagnosticsForFile(diagByFile, filePath),
    [diagByFile, filePath],
  );
  const fileDiagErrorCount = useMemo(
    () => fileDiagnostics?.filter((d) => d.severity === 1).length ?? 0,
    [fileDiagnostics],
  );
  const fileDiagWarningCount = useMemo(
    () => fileDiagnostics?.filter((d) => d.severity === 2).length ?? 0,
    [fileDiagnostics],
  );

  // Binary blob for DOCX, video, audio, PPTX — AND HEIC images.
  // PDFs intentionally use /file/content base64 so PdfRenderer can create a Blob URL from the string.
  // A bytes-only source (the project's Files) also serves the spreadsheet and
  // SQLite bytes: those renderers would otherwise read a sandbox path, and
  // there is no sandbox behind Files.
  const readsOwnBytes = fileCategory === 'xlsx' || fileCategory === 'sqlite';
  const blobPath =
    isBlobCategory(fileCategory) || isHeicImage || (source.bytesOnly && readsOwnBytes) ? filePath : null;
  const {
    blobUrl,
    blob: rawBlob,
    isLoading: blobLoading,
    error: blobError,
  } = useBinaryBlob(blobPath);

  // HEIC conversion — converts the raw HEIC blob to a renderable JPEG URL
  const { url: heicImageUrl, isConverting: heicConverting } = useHeicBlob(
    isHeicImage ? rawBlob : null,
    fileName,
  );

  const displayContent = fileContent?.content ?? '';

  // Keep latestContentRef in sync with loaded content
  useEffect(() => {
    if (fileContent?.content) {
      latestContentRef.current = fileContent.content;
    }
  }, [fileContent?.content]);

  // Reset state when the FILE changes — markdown defaults to rendered preview.
  //
  // `setIsMarkdownPreview` MUST NOT be a dependency here, and this effect must
  // not call it. That callback is memoized on the preview flag itself, so
  // listing it made every toggle re-run this effect and force the flag back to
  // `true` inside the same commit: the source/preview button flipped and
  // snapped back, which reads as a dead button. It killed BOTH toggles — this
  // component's own header button and `file-preview-modal`'s toolbar button,
  // which drives the same state through `onMarkdownPreviewChange`.
  //
  // Only the internal (uncontrolled) flag is reset. A controlling parent owns
  // its copy and resets it on the same file change — see
  // `file-preview-modal.tsx`'s own `[selectedFilePath]` effect — so notifying
  // it from here would be a second writer for one piece of state.
  useEffect(() => {
    setInternalMarkdownPreview(true);
    setIsJsonTreeView(false);
    setHasUnsavedChanges(false);
    setSaveFlash(false);
    // HTML files always default to preview mode
    setIsHtmlPreview(true);
    latestContentRef.current = '';
  }, [filePath]);

  // Notify parent of unsaved state changes
  useEffect(() => {
    onUnsavedChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onUnsavedChange]);

  // Download handler
  const handleDownload = useCallback(async () => {
    if (!fileName) return;
    try {
      await source.download(filePath, fileName);
    } catch {
      errorToast(tHardcodedUi('i18nComplete.textc85c359673e0', { value0: fileName }));
    }
  }, [fileName, source, filePath, tHardcodedUi]);

  // Save handler — called by CodeEditor (Cmd+S) and by the header Save button.
  // When called from the header button we pass latestContentRef.current.
  // When called from CodeEditor's Cmd+S, CodeEditor passes its own localContent.
  const handleSave = useCallback(
    async (content: string) => {
      if (readOnly) return;
      setIsSaving(true);
      try {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const file = new File([blob], fileName, { type: 'text/plain' });
        if (source.save) {
          await source.save(filePath, file);
        } else {
          const parentPath = filePath.substring(0, filePath.lastIndexOf('/'));
          await source.upload(file, parentPath || undefined);
        }
        // Refetch so fileContent.content (= originalContent for CodeEditor) updates.
        // CodeEditor's originalContent effect will then sync savedContent.current
        // to match localContent, clearing its internal hasChanges flag.
        await refetch();
        setHasUnsavedChanges(false);
        setSaveFlash(true);
        if (saveFlashTimerRef.current) clearTimeout(saveFlashTimerRef.current);
        saveFlashTimerRef.current = setTimeout(() => setSaveFlash(false), 2000);
        onSaved?.();
        successToast(tI18nHardcoded.raw('i18nComplete.text8d63209935bf'));
      } catch (err) {
        errorToast(
          tHardcodedUi('i18nComplete.texta35cc9aee543', {
            value0:
              err instanceof Error
                ? err.message
                : tI18nHardcoded.raw('i18nComplete.text27c2ccd962c2'),
          }),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [filePath, fileName, refetch, onSaved, readOnly, source],
  );

  // Discard handler — force-remounts CodeEditor so it re-initialises from fileContent.content.
  const handleDiscard = useCallback(() => {
    if (readOnly) return;
    latestContentRef.current = fileContent?.content ?? '';
    setHasUnsavedChanges(false);
    setDiscardKey((k) => k + 1);
  }, [readOnly, fileContent?.content]);

  // Track editor content changes (called on every keystroke by CodeEditor)
  const handleEditorChange = useCallback(
    (content: string) => {
      if (readOnly) return;
      latestContentRef.current = content;
    },
    [readOnly],
  );

  // Cmd+S handler for when CodeEditor is not mounted (e.g. markdown preview)
  useEffect(() => {
    if (readOnly || !isMarkdownPreview) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (hasUnsavedChanges && latestContentRef.current) {
          handleSave(latestContentRef.current);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [readOnly, isMarkdownPreview, hasUnsavedChanges, handleSave]);

  // Warn before leaving the page with unsaved changes
  useEffect(() => {
    if (readOnly || !hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [readOnly, hasUnsavedChanges]);

  // Image rendering — skip HEIC (handled separately via blob pipeline)
  const imageDataUrl = useMemo(() => {
    if (isHeicImage) return null;
    if (fileContent?.encoding === 'base64' && isImageMime(fileContent.mimeType)) {
      return `data:${fileContent.mimeType};base64,${fileContent.content}`;
    }
    return null;
  }, [fileContent, isHeicImage]);

  // Determine loading state
  const needsBlob = isBlobCategory(fileCategory) || isHeicImage || (!!source.bytesOnly && readsOwnBytes);
  const isContentReady = needsBlob ? !blobLoading && !blobError : !isLoading && !error;
  const contentError = needsBlob
    ? blobError
    : error instanceof Error
      ? error.message
      : error
        ? String(error)
        : null;
  const showLoadingState = needsBlob ? blobLoading : isLoading;

  // A readiness 503 means the sandbox is parked or still booting — a pending
  // state, never a failure. The file hooks keep polling while this is true
  // (SANDBOX_WAKING_REFETCH_INTERVAL_MS), so the content appears on its own
  // once the box is up.
  const isSandboxWaking = !!contentError && isSandboxNotReadyError(contentError);

  // Detect "file not found" — either via explicit error or empty resolution
  const isNotFound = useMemo(() => {
    if (contentError) return isNotFoundError(contentError);
    // Query settled with no data and no error → file likely doesn't exist
    if (!showLoadingState && !contentError && !needsBlob && !isLoading && !fileContent) return true;
    if (!showLoadingState && !contentError && needsBlob && !blobLoading && !blobError && !rawBlob)
      return true;
    return false;
  }, [
    contentError,
    showLoadingState,
    needsBlob,
    isLoading,
    fileContent,
    blobLoading,
    blobError,
    rawBlob,
  ]);

  // Report load status up (used by `show` cards to hide dead references). Only
  // fires when a caller opts in via `onStatusChange`; the default viewer is
  // unaffected.
  useEffect(() => {
    if (!onStatusChange) return;
    if (isNotFound) onStatusChange('error');
    else if (showLoadingState || isSandboxWaking) onStatusChange('loading');
    else onStatusChange('ready');
  }, [onStatusChange, isNotFound, showLoadingState, isSandboxWaking]);

  // An `image` that settled without an image to show: bytes whose mime is not
  // `image/*` (so `imageDataUrl` stayed null and the binary/text fallback ran
  // instead), or a HEIC whose blob never arrived. No ImageRenderer is mounted
  // on those paths, so nothing downstream can report the failure — this is the
  // case the surface itself has to speak for.
  //
  // A HEIC whose CONVERSION fails is deliberately not one of them:
  // `use-heic-url.ts` catches the `heic2any` rejection and falls back to a blob
  // URL over the raw bytes, which a browser with native HEIC support then
  // renders correctly. So `heicImageUrl` is set, this predicate is false, and
  // ImageRenderer mounts. Where the browser also cannot decode it, the release
  // comes from ImageRenderer exhausting its own retries ~5s later — a known,
  // accepted window during which a ratio-fitting consumer still holds the
  // previous document's width. Widening this predicate to pre-empt it would
  // break the browsers the fallback exists for.
  //
  // A HEIC whose blob just resolved is ALSO not one of them, for one render:
  // `useHeicBlob` flips `isConverting` to true inside its effect
  // (`use-heic-url.ts:29`), which runs after this render commits. On the
  // render where `blobLoading` first goes false, `heicConverting` is still
  // `false` and `heicImageUrl` is still `null` even though conversion is
  // about to start — not because it failed. Only a HEIC whose blob never
  // arrived (`rawBlob` still null/absent) counts as producing nothing.
  const heicAboutToConvert = isHeicImage && !!rawBlob;
  const imageProducedNothing =
    fileCategory === 'image' &&
    !showLoadingState &&
    !heicConverting &&
    !imageDataUrl &&
    !heicImageUrl &&
    !heicAboutToConvert;

  useEffect(() => {
    if (!previewFit || !imageProducedNothing) return;
    previewFit.reportUnmeasurable();
  }, [previewFit, imageProducedNothing]);

  return {
    source, Breadcrumbs, fileContent, isLoading, error,
    contentRevision, fetchRevision, hasUnsavedChanges, setHasUnsavedChanges, isSaving,
    saveFlash, latestContentRef, discardKey, fileName, isHeicImage,
    language, fileCategory, isMarkdownFile, isMermaidFile, hasPreviewToggle,
    isJsonFile, isHtmlFile, isMarkdownPreview, setIsMarkdownPreview, isJsonTreeView,
    setIsJsonTreeView, isHtmlPreview, setIsHtmlPreview, fileDiagErrorCount, fileDiagWarningCount,
    fileDiagnostics, tHardcodedUi, tI18nHardcoded, blobUrl, rawBlob,
    blobLoading, blobError, heicImageUrl, heicConverting, displayContent,
    handleDownload, handleSave, handleDiscard, handleEditorChange, imageDataUrl,
    needsBlob, isContentReady, contentError, showLoadingState, isSandboxWaking,
    isNotFound,
  };
}
