'use client';

import { useTranslations } from 'next-intl';

import { ClientErrorBoundary } from '@/components/common/error-boundary';
import { CodeEditor } from '@/components/file-editors/code-editor';
import { MarkdownWithFrontmatter } from '@/components/markdown/markdown-frontmatter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  appendPreviewToken,
  isSubdomainPreviewUrl,
  useAuthenticatedPreviewUrl,
} from '@/hooks/use-authenticated-preview-url';
import { useHeicBlob } from '@/hooks/use-heic-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { getAuthToken } from '@/lib/auth-token';
import { SANDBOX_PORTS } from '@/lib/platform-client';
import { getIframeSandbox } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { isHeicFile } from '@/lib/utils/heic-convert';
import { findDiagnosticsForFile, useDiagnosticsStore } from '@/stores/diagnostics-store';
import {
  AlertTriangle,
  Braces,
  Check,
  CircleAlert,
  Code,
  Download,
  Eye,
  FileWarning,
  FileX,
  GitBranch,
  Globe,
  Loader2,
  RotateCcw,
  Save,
} from 'lucide-react';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileSource } from './file-source';

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
  import('@/components/file-renderers/sqlite-renderer').then((m) => ({
    default: m.SqliteRenderer,
  })),
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

  if (
    [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'svg',
      'webp',
      'ico',
      'bmp',
      'avif',
      'tiff',
      'tif',
      'heic',
      'heif',
    ].includes(ext)
  )
    return 'image';
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
  const baseName = (fileNameLower.split('/').pop() ?? fileNameLower).split('.')[0];

  // .env files (e.g., .env, .env.local, .env.production)
  if (fileNameLower.includes('.env') || fileNameLower.startsWith('.env')) {
    return 'properties';
  }

  // Files without a useful extension — detect by base name
  if (baseName === 'dockerfile' || fileNameLower.startsWith('dockerfile.')) return 'dockerfile';
  if (baseName === 'makefile' || baseName === 'gnumakefile') return 'makefile';

  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    kt: 'kotlin',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    jsonc: 'json',
    json5: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    md: 'markdown',
    mdx: 'markdown',
    txt: 'plaintext',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    vue: 'vue',
    svelte: 'svelte',
    env: 'properties',
    ini: 'properties',
    conf: 'properties',
    cfg: 'properties',
    properties: 'properties',
    graphql: 'graphql',
    gql: 'graphql',
    prisma: 'prisma',
    proto: 'proto',
    nix: 'nix',
    lua: 'lua',
    r: 'r',
    dart: 'dart',
    tf: 'hcl',
    hcl: 'hcl',
    tfvars: 'hcl',
    diff: 'diff',
    patch: 'diff',
    vim: 'vim',
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
    <div className="flex h-full items-center justify-center">
      <Loader2 className="text-muted-foreground/40 h-4 w-4 animate-spin" />
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted/50 flex h-12 w-12 items-center justify-center rounded-2xl">
        <FileX className="text-muted-foreground/40 h-6 w-6" />
      </div>
      <p className="text-muted-foreground text-sm font-medium">
        {tHardcodedUi.raw('featuresFilesComponentsFileContentRenderer.line195JsxTextFileNotFound')}
      </p>
      <p className="text-muted-foreground/50 max-w-sm font-mono text-xs break-all">{filePath}</p>
      <p className="text-muted-foreground/40 max-w-xs text-xs">
        {tHardcodedUi.raw(
          'featuresFilesComponentsFileContentRenderer.line201JsxTextThisFileDoesNotExistOrMayHave',
        )}
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
  /** Controlled markdown preview state — when provided, overrides internal state.
   *  Lets a parent (e.g. file-preview-modal with showHeader=false) put the
   *  preview/source toggle into its own chrome. */
  markdownPreview?: boolean;
  onMarkdownPreviewChange?: (preview: boolean) => void;
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
  markdownPreview,
  onMarkdownPreviewChange,
}: FileContentRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const fileName = filePath.split('/').pop() || '';
  const isHeicImage = isHeicFile(fileName);

  // Data access is supplied by the surface (live workspace vs. project git-ref)
  // via <FileSourceProvider>, so this renderer stays presentation-only.
  const source = useFileSource();
  const { useFileContent, useBinaryBlob, Breadcrumbs } = source;

  // Text content (for code/text files, CSV, non-HEIC images).
  // HEIC files are loaded exclusively via the blob pipeline — the text/base64
  // endpoint often returns 500 for HEIC because the server can't encode them.
  const {
    data: fileContent,
    isLoading,
    error,
    refetch,
  } = useFileContent(isHeicImage ? null : filePath);

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
  const authenticatedPreviewUrl = useAuthenticatedPreviewUrl(
    isHtmlFile && isHtmlPreview ? htmlPreviewUrl : '',
  );

  // Poll the health endpoint until the static server responds
  const [serverHealth, setServerHealth] = useState<'checking' | 'ready' | 'unavailable'>(
    'checking',
  );
  const [healthRetryNonce, setHealthRetryNonce] = useState(0);
  const healthRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the transient "saved" flash timer if we unmount before it fires.
  useEffect(
    () => () => {
      if (saveFlashTimerRef.current) clearTimeout(saveFlashTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isHtmlFile || !isHtmlPreview || !htmlHealthUrl) return;

    let cancelled = false;
    // Bound the retries so this surface can never spin "Starting preview
    // server…" forever — after ~30s of failures we surface a recoverable
    // 'unavailable' state instead of looping silently.
    let attempts = 0;
    const MAX_HEALTH_ATTEMPTS = 20; // 20 × 1.5s ≈ 30s
    setServerHealth('checking');

    async function check() {
      attempts += 1;
      try {
        // Subdomain previews (p{port}-{sandbox}.host, used in local dev) can't
        // rely on the host-only /v1/p session cookie — it never reaches the
        // preview subdomain. They authenticate via a one-shot ?token on the
        // request itself, which the proxy then trusts in-memory for the whole
        // subdomain. Without it this probe 401s forever and the iframe — gated
        // on serverHealth==='ready' — never renders, so nothing ever carries a
        // token and the "Starting preview server…" state deadlocks.
        let url = htmlHealthUrl;
        if (isSubdomainPreviewUrl(htmlHealthUrl)) {
          const token = await getAuthToken();
          if (cancelled) return;
          if (token) url = appendPreviewToken(htmlHealthUrl, token);
        }
        const res = await fetch(url, { method: 'GET', credentials: 'include' });
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
      if (attempts >= MAX_HEALTH_ATTEMPTS) {
        setServerHealth('unavailable');
        return;
      }
      setServerHealth('checking');
      healthRetryRef.current = setTimeout(check, 1500);
    }

    check();

    return () => {
      cancelled = true;
      if (healthRetryRef.current) clearTimeout(healthRetryRef.current);
    };
  }, [isHtmlFile, isHtmlPreview, htmlHealthUrl, healthRetryNonce]);

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
  const blobPath = isBlobCategory(fileCategory) || isHeicImage ? filePath : null;
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

  // Reset state when file changes — markdown defaults to rendered preview.
  useEffect(() => {
    setIsMarkdownPreview(true);
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
      errorToast(`Failed to download ${fileName}`);
    }
  }, [filePath, fileName, source]);

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
        const parentPath = filePath.substring(0, filePath.lastIndexOf('/'));
        await source.upload(file, parentPath || undefined);
        // Refetch so fileContent.content (= originalContent for CodeEditor) updates.
        // CodeEditor's originalContent effect will then sync savedContent.current
        // to match localContent, clearing its internal hasChanges flag.
        await refetch();
        setHasUnsavedChanges(false);
        setSaveFlash(true);
        if (saveFlashTimerRef.current) clearTimeout(saveFlashTimerRef.current);
        saveFlashTimerRef.current = setTimeout(() => setSaveFlash(false), 2000);
        onSaved?.();
        successToast('File saved');
      } catch (err) {
        errorToast(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
  const needsBlob = isBlobCategory(fileCategory) || isHeicImage;
  const isContentReady = needsBlob ? !blobLoading && !blobError : !isLoading && !error;
  const contentError = needsBlob
    ? blobError
    : error instanceof Error
      ? error.message
      : error
        ? String(error)
        : null;
  const showLoadingState = needsBlob ? blobLoading : isLoading;

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
    <div className={cn('flex h-full flex-col', className)}>
      {/* Header */}
      {showHeader && (
        <div className="border-border/50 flex h-10 shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {Breadcrumbs && <Breadcrumbs filePath={filePath} />}
            {/* Edit state indicator */}
            {!readOnly && hasUnsavedChanges && (
              <Badge variant="warning" size="sm" className="shrink-0">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500"></span>
                </span>
                Edited
              </Badge>
            )}
            {!readOnly && saveFlash && !hasUnsavedChanges && (
              <Badge variant="success" size="sm" className="shrink-0">
                <Check className="h-3 w-3" />
                Saved
              </Badge>
            )}
            {readOnly && (
              <Badge variant="muted" size="sm" className="shrink-0 tracking-wider uppercase">
                {tHardcodedUi.raw(
                  'featuresFilesComponentsFileContentRenderer.line554JsxTextViewOnly',
                )}
              </Badge>
            )}
            {/* Inline diagnostic counts */}
            {(fileDiagErrorCount > 0 || fileDiagWarningCount > 0) && (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                {fileDiagErrorCount > 0 && (
                  <span className="text-destructive inline-flex items-center gap-0.5 text-xs font-medium">
                    <CircleAlert className="h-3 w-3" />
                    {fileDiagErrorCount}
                  </span>
                )}
                {fileDiagWarningCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-medium text-yellow-500">
                    <AlertTriangle className="h-3 w-3" />
                    {fileDiagWarningCount}
                  </span>
                )}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {/* Explicit Save button — only when editing and has changes */}
            {!readOnly && hasUnsavedChanges && fileContent?.type === 'text' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 gap-1.5 px-3 text-xs font-medium"
                  onClick={() => handleSave(latestContentRef.current)}
                  disabled={isSaving}
                  title={tHardcodedUi.raw(
                    'featuresFilesComponentsFileContentRenderer.line586JsxAttrTitleSaveS',
                  )}
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
                  className="text-muted-foreground hover:text-foreground h-7 w-7"
                  onClick={handleDiscard}
                  title={tHardcodedUi.raw(
                    'featuresFilesComponentsFileContentRenderer.line600JsxAttrTitleDiscardChanges',
                  )}
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
                {isHtmlPreview ? <Code className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
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
                {isMarkdownPreview ? <Code className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            )}

            {/* Additional header actions from parent */}
            {headerActions}

            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground/60 hover:text-foreground h-7 w-7"
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
        <ClientErrorBoundary
          fallback={() => (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-2xl">
                <FileWarning className="text-destructive/50 h-6 w-6" />
              </div>
              <p className="text-muted-foreground text-sm font-medium">
                Couldn&apos;t preview this file
              </p>
              <p className="text-muted-foreground/50 max-w-sm font-mono text-xs break-all">
                {filePath}
              </p>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download
              </Button>
            </div>
          )}
        >
          {/* Loading */}
          {showLoadingState && (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-muted-foreground/40 h-4 w-4 animate-spin" />
            </div>
          )}

          {/* Error */}
          {contentError &&
            !showLoadingState &&
            (errorFallback ? (
              errorFallback(contentError, filePath)
            ) : isNotFound ? (
              <FileNotFoundState filePath={filePath} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-2xl">
                  <FileWarning className="text-destructive/50 h-6 w-6" />
                </div>
                <p className="text-muted-foreground text-sm font-medium">
                  {tHardcodedUi.raw(
                    'featuresFilesComponentsFileContentRenderer.line692JsxTextFailedToLoadFile',
                  )}
                </p>
                <p className="text-muted-foreground/50 max-w-sm font-mono text-xs break-all">
                  {filePath}
                </p>
                <p className="text-muted-foreground/60 max-w-sm text-xs">{contentError}</p>
              </div>
            ))}

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
              <XlsxRenderer filePath={filePath} fileName={fileName} className="h-full" />
            </Suspense>
          )}

          {/* SQLite database viewer */}
          {!isLoading && !error && !isNotFound && fileCategory === 'sqlite' && (
            <Suspense fallback={<RendererFallback />}>
              <SqliteRenderer
                filePath={filePath}
                fileName={fileName}
                className="h-full"
                readOnly={readOnly}
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
            <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
              <div className="bg-muted/50 flex h-14 w-14 items-center justify-center rounded-2xl">
                <svg
                  className="text-muted-foreground/40 h-6 w-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
              <p className="text-muted-foreground/60 text-sm">{fileName}</p>
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
              {serverHealth !== 'unavailable' &&
                (serverHealth === 'checking' || !authenticatedPreviewUrl) && (
                  <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3">
                    <Loader2 className="h-5 w-5 animate-spin opacity-40" />
                    <p className="text-xs opacity-50">
                      {tHardcodedUi.raw(
                        'featuresFilesComponentsFileContentRenderer.line805JsxTextStartingPreviewServer',
                      )}
                    </p>
                  </div>
                )}

              {/* Preview server never responded — recoverable, offer a retry */}
              {serverHealth === 'unavailable' && (
                <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <FileWarning className="h-5 w-5 opacity-40" />
                  <p className="max-w-xs text-xs opacity-60">
                    {"Couldn't reach the preview server. The sandbox may still be starting up."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setHealthRetryNonce((n) => n + 1)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              )}

              {/* Server ready — render iframe */}
              {serverHealth === 'ready' && authenticatedPreviewUrl && (
                <iframe
                  key={`html-preview-${filePath}`}
                  src={authenticatedPreviewUrl}
                  title={fileName}
                  className="h-full w-full border-0"
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
              className={readOnly ? 'min-h-full' : 'h-full'}
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
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="bg-muted/50 flex h-12 w-12 items-center justify-center rounded-2xl">
                  <FileWarning className="text-muted-foreground/30 h-6 w-6" />
                </div>
                <p className="text-muted-foreground/50 text-sm">
                  {tHardcodedUi.raw(
                    'featuresFilesComponentsFileContentRenderer.line844JsxTextBinaryFile',
                  )}
                </p>
                <Button variant="outline" size="sm" className="" onClick={handleDownload}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
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
              <div className={cn('relative flex flex-col', readOnly ? 'min-h-full' : 'h-full')}>
                {/* Diff indicator */}
                {fileContent.patch && fileContent.patch.hunks.length > 0 && (
                  <InfoBanner
                    tone="warning"
                    icon={GitBranch}
                    className="shrink-0 items-center gap-1.5 rounded-none border-x-0 border-t-0 px-3 py-1.5"
                  >
                    {tHardcodedUi.raw(
                      'featuresFilesComponentsFileContentRenderer.line869JsxTextUncommittedChanges',
                    )}
                  </InfoBanner>
                )}
                {isJsonTreeView && isJsonFile ? (
                  <div key={filePath} className="h-full w-full overflow-auto">
                    <JsonTreeView
                      content={hasUnsavedChanges ? latestContentRef.current : displayContent}
                    />
                  </div>
                ) : isMarkdownPreview && isMarkdownFile ? (
                  <div key={filePath} className="h-full w-full overflow-auto p-6">
                    <MarkdownWithFrontmatter
                      content={hasUnsavedChanges ? latestContentRef.current : displayContent}
                    />
                  </div>
                ) : (
                  <CodeEditor
                    key={`${filePath}-${discardKey}`}
                    {...codeEditorProps}
                    className={readOnly ? 'min-h-full' : 'h-full'}
                  />
                )}
              </div>
            )}

          {/* File not found fallback — catches cases where loading settled but no content/error */}
          {!showLoadingState && !contentError && isNotFound && (
            <FileNotFoundState filePath={filePath} />
          )}
        </ClientErrorBoundary>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline JSON Tree View
// ---------------------------------------------------------------------------

function JsonTreeView({ content }: { content: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const parsed = useMemo(() => {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }, [content]);

  if (parsed === null) {
    return (
      <div className="text-destructive/70 p-4 font-mono text-sm">
        {tHardcodedUi.raw('featuresFilesComponentsFileContentRenderer.line915JsxTextInvalidJson')}
      </div>
    );
  }

  return (
    <div className="p-4 font-mono text-sm leading-relaxed">
      <JsonNode value={parsed} keyName={null} depth={0} />
    </div>
  );
}

function JsonNode({
  value,
  keyName,
  depth,
}: {
  value: unknown;
  keyName: string | null;
  depth: number;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
          {tHardcodedUi.raw('featuresFilesComponentsFileContentRenderer.line963JsxTextQuot')}
          {value.length > 200 ? value.slice(0, 200) + '...' : value}
          {tHardcodedUi.raw(
            'featuresFilesComponentsFileContentRenderer.line963JsxTextQuotb4125902',
          )}
        </span>
        {isUrl && (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 text-xs text-blue-400/60 hover:text-blue-400"
          >
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
          className="hover:bg-muted/30 inline-flex cursor-pointer items-center gap-1 rounded-lg transition-colors"
          onClick={() => setIsCollapsed((v) => !v)}
        >
          <span className="text-muted-foreground/40 w-3.5 text-center text-xs select-none">
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
          {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
          {isCollapsed ? (
            <span className="text-muted-foreground/40">
              [{count} item{count !== 1 ? 's' : ''}]
            </span>
          ) : (
            <span className="text-muted-foreground/30">[</span>
          )}
        </div>
        {!isCollapsed && (
          <>
            {value.map((item, idx) => (
              <JsonNode key={idx} value={item} keyName={null} depth={depth + 1} />
            ))}
            <div style={{ paddingLeft: depth * 20 }} className="text-muted-foreground/30">
              ]
            </div>
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
          className="hover:bg-muted/30 inline-flex cursor-pointer items-center gap-1 rounded-lg transition-colors"
          onClick={() => setIsCollapsed((v) => !v)}
        >
          <span className="text-muted-foreground/40 w-3.5 text-center text-xs select-none">
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
          {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
          {isCollapsed ? (
            <span className="text-muted-foreground/40">
              {'{' + count + ' key' + (count !== 1 ? 's' : '') + '}'}
            </span>
          ) : (
            <span className="text-muted-foreground/30">{'{'}</span>
          )}
        </div>
        {!isCollapsed && (
          <>
            {entries.map(([k, v]) => (
              <JsonNode key={k} value={v} keyName={k} depth={depth + 1} />
            ))}
            <div style={{ paddingLeft: depth * 20 }} className="text-muted-foreground/30">
              {'}'}
            </div>
          </>
        )}
      </div>
    );
  }

  return null;
}
