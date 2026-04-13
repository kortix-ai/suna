'use client';

import React, { useMemo, useCallback, useState, useEffect, useRef, lazy, Suspense } from 'react';
import {
  AlertTriangle,
  Braces,
  CircleAlert,
  Code,
  Download,
  Eye,
  FileWarning,
  FileX,
  GitBranch,
  Globe,
  Loader2,
  Save,
  RotateCcw,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFileContent } from '../hooks';
import { downloadFile, uploadFile } from '../api/opencode-files';
import { useBinaryBlob } from '../hooks/use-binary-blob';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { UnifiedMarkdown } from '@/components/markdown';
import { CodeEditor } from '@/components/file-editors/code-editor';
import { useDiagnosticsStore, findDiagnosticsForFile } from '@/stores/diagnostics-store';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { SANDBOX_PORTS } from '@/lib/platform-client';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { getIframeSandbox } from '@/lib/security/iframe-sandbox';
import { FilePathBreadcrumbs } from './file-breadcrumbs';
import { isHeicFile } from '@/lib/utils/heic-convert';
import { useHeicBlob } from '@/hooks/use-heic-url';

// ---------------------------------------------------------------------------
// Lazy-load heavy renderers to keep initial bundle small
// ---------------------------------------------------------------------------

const PdfRenderer = lazy(() =>
  import('@/components/file-renderers/pdf-renderer').then((m) => ({ default: m.PdfRenderer })),
);
const DocxRenderer = lazy(() =>
  import('@/components/file-renderers/docx-renderer').then((m) => ({ default: m.DocxRenderer })),
);
const VideoRenderer = lazy(() =>
  import('@/components/file-renderers/video-renderer').then((m) => ({ default: m.VideoRenderer })),
);
const CsvRenderer = lazy(() =>
  import('@/components/file-renderers/csv-renderer').then((m) => ({ default: m.CsvRenderer })),
);
const XlsxRenderer = lazy(() =>
  import('@/components/file-renderers/xlsx-renderer').then((m) => ({ default: m.XlsxRenderer })),
);
const PptxRenderer = lazy(() =>
  import('@/components/file-renderers/pptx-renderer').then((m) => ({ default: m.PptxRenderer })),
);
const ImageRenderer = lazy(() =>
  import('@/components/file-renderers/image-renderer').then((m) => ({ default: m.ImageRenderer })),
);
const SqliteRenderer = lazy(() =>
  import('@/components/file-renderers/sqlite-renderer').then((m) => ({ default: m.SqliteRenderer })),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a sandbox file path starts with /workspace/ for the static file server. */
function ensureWorkspacePath(filePath: string): string {
  if (filePath.startsWith('/workspace/')) return filePath;
  return '/workspace/' + filePath.replace(/^\/+/, '');
}

/** Categories that need a blob fetched via readFileAsBlob */
const BLOB_CATEGORIES = ['pdf', 'docx', 'video', 'audio', 'pptx'] as const;
type BlobCategory = (typeof BLOB_CATEGORIES)[number];

export type FileCategory =
  | 'image'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'csv'
  | 'sqlite'
  | 'video'
  | 'audio'
  | 'html'
  | 'code'
  | 'text'
  | 'binary';

export function getFileCategory(filename: string, mimeType?: string): FileCategory {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif', 'tiff', 'tif', 'heic', 'heif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['pptx', 'ppt'].includes(ext)) return 'pptx';
  if (['xlsx', 'xls'].includes(ext)) return 'xlsx';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (['db', 'sqlite', 'sqlite3', 'db3', 'sdb', 's3db'].includes(ext)) return 'sqlite';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) return 'audio';
  if (['html', 'htm'].includes(ext)) return 'html';

  // Code/text files
  if (getLanguageFromExt(filename) !== 'plaintext') return 'code';
  if (mimeType?.startsWith('text/')) return 'text';

  return 'binary';
}

export function getLanguageFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const fileNameLower = filename.toLowerCase();
  
  // .env files (e.g., .env, .env.local, .env.production)
  if (fileNameLower.includes('.env') || fileNameLower.startsWith('.env')) {
    return 'properties';
  }
  
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', kt: 'kotlin', php: 'php',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    xml: 'xml', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
    md: 'markdown', mdx: 'markdown', txt: 'plaintext',
    dockerfile: 'dockerfile', makefile: 'makefile',
    vue: 'vue', svelte: 'svelte',
    env: 'properties', ini: 'properties', conf: 'properties',
    cfg: 'properties', properties: 'properties',
  };
  return map[ext] || 'plaintext';
}

function isImageMime(mimeType?: string): boolean {
  return !!mimeType && mimeType.startsWith('image/');
}

function isBlobCategory(cat: FileCategory): cat is BlobCategory {
  return (BLOB_CATEGORIES as readonly string[]).includes(cat);
}

/** Spinner placeholder used inside <Suspense> for lazy-loaded renderers. */
function RendererFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
    </div>
  );
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

/** Shared "file does not exist" UI shown when a file cannot be loaded. */
function FileNotFoundState({ filePath }: { filePath: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
      <div className="h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center">
        <FileX className="h-6 w-6 text-muted-foreground/40" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">
        File not found
      </p>
      <p className="text-xs font-mono text-muted-foreground/50 max-w-sm break-all">
        {filePath}
      </p>
      <p className="text-xs text-muted-foreground/40 max-w-xs">
        This file does not exist or may have been deleted.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileContentRenderer — the shared file content rendering component
// ---------------------------------------------------------------------------

export interface FileContentRendererProps {
  /** Path to the file to render */
  filePath: string;
  /** Whether to show the compact header bar with file name, toggles, save/download buttons */
  showHeader?: boolean;
  /** Additional header actions (rendered after built-in buttons) */
  headerActions?: React.ReactNode;
  /** Callback when unsaved state changes */
  onUnsavedChange?: (hasUnsaved: boolean) => void;
  /** Callback when content is saved */
  onSaved?: () => void;
  /** Additional class name for the root container */
  className?: string;
  /** Custom error UI. When provided, replaces the default error display.
   *  Receives the error message and filePath so callers can render a graceful fallback. */
  errorFallback?: (error: string, filePath: string) => React.ReactNode;
  /** 1-indexed line number to scroll to after mount */
  targetLine?: number | null;
  /** When true, the file is displayed in view-only mode — no editing, no save. */
  readOnly?: boolean;
}

export function FileContentRenderer({
  filePath,
  showHeader = true,
  headerActions,
  onUnsavedChange,
  onSaved,
  className,
  errorFallback,
  targetLine,
  readOnly = false,
}: FileContentRendererProps) {
  const fileName = filePath.split('/').pop() || '';
  const isHeicImage = isHeicFile(fileName);

  // Text content (for code/text files, CSV, non-HEIC images).
  // HEIC files are loaded exclusively via the blob pipeline — the text/base64
  // endpoint often returns 500 for HEIC because the server can't encode them.
  const { data: fileContent, isLoading, error, refetch } = useFileContent(
    isHeicImage ? null : filePath,
  );

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
  const isJsonFile = language === 'json';
  const isHtmlFile = fileCategory === 'html';
  const [isMarkdownPreview, setIsMarkdownPreview] = useState(false);
  const [isJsonTreeView, setIsJsonTreeView] = useState(false);
  // HTML files default to rendered preview mode
  const [isHtmlPreview, setIsHtmlPreview] = useState(true);

  // Build proxied static-file-server URLs for HTML preview
  const { rewritePortPath } = useSandboxProxy();
  const staticPort = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);

  const htmlPreviewUrl = useMemo(() => {
    if (!isHtmlFile) return '';
    const normalizedPath = ensureWorkspacePath(filePath);
    const encodedPath = normalizedPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return rewritePortPath(staticPort, `/open?path=/${encodedPath}`);
  }, [isHtmlFile, filePath, rewritePortPath, staticPort]);

  // Health URL: hit /health on the static file server through the proxy
  const htmlHealthUrl = useMemo(() => {
    if (!isHtmlFile) return '';
    return rewritePortPath(staticPort, '/health');
  }, [isHtmlFile, rewritePortPath, staticPort]);

  // Authenticate the preview session before rendering the iframe
  const authenticatedPreviewUrl = useAuthenticatedPreviewUrl(isHtmlFile && isHtmlPreview ? htmlPreviewUrl : '');

  // Poll the health endpoint until the static server responds
  const [serverHealth, setServerHealth] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const healthRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isHtmlFile || !isHtmlPreview || !htmlHealthUrl) return;

    let cancelled = false;
    setServerHealth('checking');

    async function check() {
      try {
        const res = await fetch(htmlHealthUrl, { method: 'GET', credentials: 'include' });
        if (cancelled) return;
        if (res.ok) {
          setServerHealth('ready');
        } else {
          retry();
        }
      } catch {
        if (!cancelled) retry();
      }
    }

    function retry() {
      if (cancelled) return;
      setServerHealth('checking');
      healthRetryRef.current = setTimeout(check, 1500);
    }

    check();

    return () => {
      cancelled = true;
      if (healthRetryRef.current) clearTimeout(healthRetryRef.current);
    };
  }, [isHtmlFile, isHtmlPreview, htmlHealthUrl]);

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

  // Binary blob for PDF, DOCX, video, audio, PPTX — AND HEIC images
  const blobPath = (isBlobCategory(fileCategory) || isHeicImage) ? filePath : null;
  const { blobUrl, blob: rawBlob, isLoading: blobLoading, error: blobError } = useBinaryBlob(blobPath);

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

  // Reset state when file changes — default to edit mode for markdown
  useEffect(() => {
    setIsMarkdownPreview(false);
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
      await downloadFile(filePath, fileName);
    } catch {
      toast.error(`Failed to download ${fileName}`);
    }
  }, [filePath, fileName]);

  // Save handler — called by CodeEditor (Cmd+S) and by the header Save button.
  // When called from the header button we pass latestContentRef.current.
  // When called from CodeEditor's Cmd+S, CodeEditor passes its own localContent.
  const handleSave = useCallback(async (content: string) => {
    if (readOnly) return;
    setIsSaving(true);
    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const file = new File([blob], fileName, { type: 'text/plain' });
      const parentPath = filePath.substring(0, filePath.lastIndexOf('/'));
      await uploadFile(file, parentPath || undefined);
      // Refetch so fileContent.content (= originalContent for CodeEditor) updates.
      // CodeEditor's originalContent effect will then sync savedContent.current
      // to match localContent, clearing its internal hasChanges flag.
      await refetch();
      setHasUnsavedChanges(false);
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 2000);
      onSaved?.();
      toast.success('File saved');
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  }, [filePath, fileName, refetch, onSaved, readOnly]);

  // Discard handler — force-remounts CodeEditor so it re-initialises from fileContent.content.
  const handleDiscard = useCallback(() => {
    if (readOnly) return;
    latestContentRef.current = fileContent?.content ?? '';
    setHasUnsavedChanges(false);
    setDiscardKey((k) => k + 1);
  }, [readOnly, fileContent?.content]);

  // Track editor content changes (called on every keystroke by CodeEditor)
  const handleEditorChange = useCallback((content: string) => {
    if (readOnly) return;
    latestContentRef.current = content;
  }, [readOnly]);

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
    if (
      fileContent?.encoding === 'base64' &&
      isImageMime(fileContent.mimeType)
    ) {
      return `data:${fileContent.mimeType};base64,${fileContent.content}`;
    }
    return null;
  }, [fileContent, isHeicImage]);

  // Determine loading state
  const needsBlob = isBlobCategory(fileCategory) || isHeicImage;
  const isContentReady = needsBlob
    ? (!blobLoading && !blobError)
    : (!isLoading && !error);
  const contentError = needsBlob ? blobError : (error instanceof Error ? error.message : error ? String(error) : null);
  const showLoadingState = needsBlob ? blobLoading : isLoading;

  // Detect "file not found" — either via explicit error or empty resolution
  const isNotFound = useMemo(() => {
    if (contentError) return isNotFoundError(contentError);
    // Query settled with no data and no error → file likely doesn't exist
    if (!showLoadingState && !contentError && !needsBlob && !isLoading && !fileContent) return true;
    if (!showLoadingState && !contentError && needsBlob && !blobLoading && !blobError && !rawBlob) return true;
    return false;
  }, [contentError, showLoadingState, needsBlob, isLoading, fileContent, blobLoading, blobError, rawBlob]);

  // ---------------------------------------------------------------------------
  // Shared CodeEditor props — keeps edit & read-only paths DRY
  // ---------------------------------------------------------------------------
  // IMPORTANT: Always pass fileContent.content as both `content` and
  // `originalContent`. CodeEditor manages its own localContent internally.
  // When the user edits, localContent diverges from savedContent.current.
  // After save + refetch, originalContent updates → CodeEditor's effect
  // syncs savedContent.current → hasChanges clears automatically.
  // Passing latestContentRef.current as content was causing a desync where
  // CodeEditor's savedContent never updated and hasChanges stayed true.
  const codeEditorProps = {
    content: fileContent?.content ?? '',
    originalContent: fileContent?.content ?? '',
    fileName,
    onSave: readOnly ? undefined : handleSave,
    onChange: readOnly ? undefined : handleEditorChange,
    onUnsavedChange: readOnly ? undefined : setHasUnsavedChanges,
    readOnly,
    showHeader: false,
    fontSize: 'text-sm' as const,
    diagnostics: fileDiagnostics,
    targetLine,
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      {showHeader && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 shrink-0 h-10">
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <FilePathBreadcrumbs filePath={filePath} />
            {/* Edit state indicator */}
            {!readOnly && hasUnsavedChanges && (
              <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500 px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 rounded-md shrink-0">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
                </span>
                <span className="font-semibold">Edited</span>
              </div>
            )}
            {!readOnly && saveFlash && !hasUnsavedChanges && (
              <div className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500 px-2 py-0.5 bg-green-50 dark:bg-green-900/20 rounded-md shrink-0">
                <Check className="h-3 w-3" />
                <span className="font-semibold">Saved</span>
              </div>
            )}
            {readOnly && (
              <span className="text-[10px] text-muted-foreground/60 px-1.5 py-0.5 bg-muted/50 rounded shrink-0 uppercase tracking-wider font-medium">
                View only
              </span>
            )}
            {/* Inline diagnostic counts */}
            {(fileDiagErrorCount > 0 || fileDiagWarningCount > 0) && (
              <span className="inline-flex items-center gap-1.5 shrink-0">
                {fileDiagErrorCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-red-500 text-xs font-medium">
                    <CircleAlert className="h-3 w-3" />
                    {fileDiagErrorCount}
                  </span>
                )}
                {fileDiagWarningCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-yellow-500 text-xs font-medium">
                    <AlertTriangle className="h-3 w-3" />
                    {fileDiagWarningCount}
                  </span>
                )}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            {/* Explicit Save button — only when editing and has changes */}
            {!readOnly && hasUnsavedChanges && fileContent?.type === 'text' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 px-3 text-xs gap-1.5 font-medium"
                  onClick={() => handleSave(latestContentRef.current)}
                  disabled={isSaving}
                  title="Save (⌘S)"
                >
                  {isSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={handleDiscard}
                  title="Discard changes"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </>
            )}

            {/* HTML preview toggle */}
            {isHtmlFile && (
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-7 w-7', isHtmlPreview && 'text-primary')}
                onClick={() => setIsHtmlPreview((v) => !v)}
                title={isHtmlPreview ? 'View source' : 'Preview'}
              >
                {isHtmlPreview ? (
                  <Code className="h-4 w-4" />
                ) : (
                  <Globe className="h-4 w-4" />
                )}
              </Button>
            )}

            {/* JSON tree toggle */}
            {isJsonFile && fileContent?.type === 'text' && (
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-7 w-7', isJsonTreeView && 'text-primary')}
                onClick={() => setIsJsonTreeView((v) => !v)}
                title={isJsonTreeView ? 'View source' : 'Tree view'}
              >
                <Braces className="h-4 w-4" />
              </Button>
            )}

            {/* Markdown preview toggle */}
            {isMarkdownFile && fileContent?.type === 'text' && (
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-7 w-7', isMarkdownPreview && 'text-primary')}
                onClick={() => setIsMarkdownPreview((v) => !v)}
                title={isMarkdownPreview ? 'View source' : 'Preview'}
              >
                {isMarkdownPreview ? (
                  <Code className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            )}

            {/* Additional header actions from parent */}
            {headerActions}

            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
              onClick={handleDownload}
              disabled={!fileContent && !blobUrl && !rawBlob}
              title="Download"
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Content area — readOnly uses overflow-auto so the read-only editor
          (which renders at auto height) can scroll within the fixed-size parent. */}
      <div className={cn('flex-1', readOnly ? 'overflow-auto' : 'overflow-hidden')}>
        {/* Loading */}
        {showLoadingState && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
          </div>
        )}

        {/* Error */}
        {contentError && !showLoadingState && (
          errorFallback ? errorFallback(contentError, filePath) : (
            isNotFound ? (
              <FileNotFoundState filePath={filePath} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
                <div className="h-12 w-12 rounded-xl bg-destructive/10 flex items-center justify-center">
                  <FileWarning className="h-6 w-6 text-destructive/50" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">
                  Failed to load file
                </p>
                <p className="text-xs text-muted-foreground/50 max-w-sm break-all font-mono">
                  {filePath}
                </p>
                <p className="text-xs text-muted-foreground/60 max-w-sm">
                  {contentError}
                </p>
              </div>
            )
          )
        )}

        {/* Image content (non-HEIC) */}
        {!isLoading && !error && imageDataUrl && (
          <Suspense fallback={<RendererFallback />}>
            <ImageRenderer url={imageDataUrl} className="h-full" fileName={fileName} />
          </Suspense>
        )}

        {/* HEIC image — loaded as raw blob, converted to JPEG client-side */}
        {isHeicImage && (blobLoading || heicConverting) && <RendererFallback />}
        {isHeicImage && !blobLoading && !blobError && heicImageUrl && !heicConverting && (
          <Suspense fallback={<RendererFallback />}>
            <ImageRenderer url={heicImageUrl} className="h-full" fileName={fileName} />
          </Suspense>
        )}

        {/* PDF preview */}
        {isContentReady && fileCategory === 'pdf' && rawBlob && (
          <Suspense fallback={<RendererFallback />}>
            <PdfRenderer blob={rawBlob} className="h-full" />
          </Suspense>
        )}

        {/* DOCX preview */}
        {isContentReady && fileCategory === 'docx' && rawBlob && (
          <Suspense fallback={<RendererFallback />}>
            <DocxRenderer blob={rawBlob} className="h-full" />
          </Suspense>
        )}

        {/* XLSX / XLS preview */}
        {!isLoading && !error && !isNotFound && fileCategory === 'xlsx' && (
          <Suspense fallback={<RendererFallback />}>
            <XlsxRenderer
              filePath={filePath}
              fileName={fileName}
              className="h-full"
            />
          </Suspense>
        )}

        {/* SQLite database viewer */}
        {!isLoading && !error && !isNotFound && fileCategory === 'sqlite' && (
          <Suspense fallback={<RendererFallback />}>
            <SqliteRenderer
              filePath={filePath}
              fileName={fileName}
              className="h-full"
            />
          </Suspense>
        )}

        {/* CSV / TSV preview */}
        {!isLoading && !error && fileCategory === 'csv' && fileContent && (
          <Suspense fallback={<RendererFallback />}>
            <CsvRenderer content={fileContent.content} className="h-full" />
          </Suspense>
        )}

        {/* Video preview */}
        {isContentReady && fileCategory === 'video' && blobUrl && (
          <Suspense fallback={<RendererFallback />}>
            <VideoRenderer url={blobUrl} className="h-full" onDownload={handleDownload} />
          </Suspense>
        )}

        {/* Audio preview */}
        {isContentReady && fileCategory === 'audio' && blobUrl && (
          <div className="flex flex-col items-center justify-center h-full gap-5 p-8">
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
              <svg className="h-6 w-6 text-muted-foreground/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <p className="text-sm text-muted-foreground/60">{fileName}</p>
            <audio controls src={blobUrl} className="w-full max-w-sm" />
          </div>
        )}

        {/* PPTX preview */}
        {isContentReady && fileCategory === 'pptx' && rawBlob && (
          <Suspense fallback={<RendererFallback />}>
            <PptxRenderer
              blob={rawBlob}
              binaryUrl={blobUrl}
              filePath={filePath}
              fileName={fileName}
              className="h-full"
              onDownload={handleDownload}
            />
          </Suspense>
        )}

        {/* HTML preview via static file server */}
        {isHtmlFile && isHtmlPreview && (
          <>
            {/* Server still starting — spinner + polling message */}
            {(serverHealth === 'checking' || !authenticatedPreviewUrl) && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin opacity-40" />
                <p className="text-xs opacity-50">Starting preview server…</p>
              </div>
            )}

            {/* Server ready — render iframe */}
            {serverHealth === 'ready' && authenticatedPreviewUrl && (
              <iframe
                key={`html-preview-${filePath}`}
                src={authenticatedPreviewUrl}
                title={fileName}
                className="w-full h-full border-0"
                sandbox={getIframeSandbox({ isolateHtmlPreview: true })}
              />
            )}
          </>
        )}

        {/* HTML source — shown when preview toggle is off */}
        {isHtmlFile && !isHtmlPreview && !isLoading && !error && fileContent?.type === 'text' && (
          <CodeEditor
            key={`html-source-${filePath}-${discardKey}`}
            {...codeEditorProps}
            className="h-full"
          />
        )}

        {/* Binary fallback */}
        {!isLoading &&
          !error &&
          fileContent &&
          fileContent.type === 'binary' &&
          !imageDataUrl &&
          !isHeicImage &&
          !['pdf', 'docx', 'pptx', 'xlsx', 'sqlite', 'video', 'audio'].includes(fileCategory) && (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
              <div className="h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center">
                <FileWarning className="h-6 w-6 text-muted-foreground/30" />
              </div>
              <p className="text-sm text-muted-foreground/50">
                Binary file
              </p>
              <Button variant="outline" size="sm" className="" onClick={handleDownload}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Download
              </Button>
            </div>
          )}

        {/* Text / code content */}
        {!isLoading &&
          !error &&
          fileContent &&
          fileContent.type === 'text' &&
          !imageDataUrl &&
          fileCategory !== 'csv' &&
          fileCategory !== 'html' && (
            <div className="relative h-full flex flex-col">
              {/* Diff indicator */}
              {fileContent.patch && fileContent.patch.hunks.length > 0 && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-500/5 border-b border-yellow-500/15 text-xs text-yellow-600 dark:text-yellow-400/80 shrink-0">
                  <GitBranch className="h-3 w-3" />
                  Uncommitted changes
                </div>
              )}
              {isJsonTreeView && isJsonFile ? (
                <div key={filePath} className="w-full h-full overflow-auto">
                  <JsonTreeView content={hasUnsavedChanges ? latestContentRef.current : displayContent} />
                </div>
              ) : isMarkdownPreview && isMarkdownFile ? (
                <div key={filePath} className="w-full h-full overflow-auto p-6">
                  <UnifiedMarkdown content={hasUnsavedChanges ? latestContentRef.current : displayContent} />
                </div>
              ) : (
                <CodeEditor
                  key={`${filePath}-${discardKey}`}
                  {...codeEditorProps}
                  className="h-full"
                />
              )}
            </div>
          )}

        {/* File not found fallback — catches cases where loading settled but no content/error */}
        {!showLoadingState && !contentError && isNotFound && (
          <FileNotFoundState filePath={filePath} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline JSON Tree View
// ---------------------------------------------------------------------------

function JsonTreeView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }, [content]);

  if (parsed === null) {
    return (
      <div className="p-4 text-sm text-red-500/70 font-mono">
        Invalid JSON
      </div>
    );
  }

  return (
    <div className="p-4 font-mono text-sm leading-relaxed">
      <JsonNode value={parsed} keyName={null} depth={0} />
    </div>
  );
}

function JsonNode({ value, keyName, depth }: { value: unknown; keyName: string | null; depth: number }) {
  const [isCollapsed, setIsCollapsed] = useState(depth > 2);

  if (value === null) {
    return (
      <div style={{ paddingLeft: depth * 20 }}>
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-muted-foreground/50 italic">null</span>
      </div>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <div style={{ paddingLeft: depth * 20 }}>
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-yellow-500/80">{String(value)}</span>
      </div>
    );
  }

  if (typeof value === 'number') {
    return (
      <div style={{ paddingLeft: depth * 20 }}>
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-cyan-500/80">{String(value)}</span>
      </div>
    );
  }

  if (typeof value === 'string') {
    const isUrl = /^https?:\/\//.test(value);
    return (
      <div style={{ paddingLeft: depth * 20 }} className="break-all">
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-emerald-500/80">
          &quot;{value.length > 200 ? value.slice(0, 200) + '...' : value}&quot;
        </span>
        {isUrl && (
          <a href={value} target="_blank" rel="noopener noreferrer" className="ml-1 text-blue-400/60 hover:text-blue-400 text-xs">
            open
          </a>
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    const count = value.length;
    return (
      <div>
        <div
          style={{ paddingLeft: depth * 20 }}
          className="cursor-pointer hover:bg-muted/30 rounded-sm transition-colors inline-flex items-center gap-1"
          onClick={() => setIsCollapsed((v) => !v)}
        >
          <span className="text-muted-foreground/40 text-xs w-3.5 text-center select-none">
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
          {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
          {isCollapsed ? (
            <span className="text-muted-foreground/40">[{count} item{count !== 1 ? 's' : ''}]</span>
          ) : (
            <span className="text-muted-foreground/30">[</span>
          )}
        </div>
        {!isCollapsed && (
          <>
            {value.map((item, idx) => (
              <JsonNode key={idx} value={item} keyName={null} depth={depth + 1} />
            ))}
            <div style={{ paddingLeft: depth * 20 }} className="text-muted-foreground/30">]</div>
          </>
        )}
      </div>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const count = entries.length;
    return (
      <div>
        <div
          style={{ paddingLeft: depth * 20 }}
          className="cursor-pointer hover:bg-muted/30 rounded-sm transition-colors inline-flex items-center gap-1"
          onClick={() => setIsCollapsed((v) => !v)}
        >
          <span className="text-muted-foreground/40 text-xs w-3.5 text-center select-none">
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
          {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
          {isCollapsed ? (
            <span className="text-muted-foreground/40">{'{' + count + ' key' + (count !== 1 ? 's' : '') + '}'}</span>
          ) : (
            <span className="text-muted-foreground/30">{'{'}</span>
          )}
        </div>
        {!isCollapsed && (
          <>
            {entries.map(([k, v]) => (
              <JsonNode key={k} value={v} keyName={k} depth={depth + 1} />
            ))}
            <div style={{ paddingLeft: depth * 20 }} className="text-muted-foreground/30">{'}'}</div>
          </>
        )}
      </div>
    );
  }

  return null;
}
