'use client';

/**
 * ShowContentRenderer — THE single source-of-truth for rendering
 * show tool content inline in the session chat and side panel.
 *
 * Architecture:
 *  Binary files (image, video, audio, docx, pptx)
 *    → loaded via useBinaryBlob (/file/raw endpoint, direct binary fetch)
 *    → rendered with shared leaf renderers (ImageRenderer, PdfRenderer, etc.)
 *
 *  Text data files (csv)
 *    → loaded via useFileContent (SDK text read)
 *    → rendered with CsvRenderer
 *
 *  Self-loading (xlsx)
 *    → XlsxRenderer handles its own data loading
 *
 *  Generic file (json, yaml, ts, py, etc.)
 *    → delegated to FileContentRenderer (handles text/code rendering)
 *
 *  Content-based (text, code, markdown, html, error)
 *    → rendered inline, no SDK calls needed
 *
 *  URL / localhost
 *    → hero link card or proxied iframe
 */

import { TextWithPaths } from '@/components/common/clickable-path';
import { CodeHighlight, UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { toSandboxAbsolutePath } from '@/features/files/api/opencode-files';
import { FileContentRenderer } from '@/features/files/components/file-content-renderer';
import { useBinaryBlob } from '@/features/files/hooks/use-binary-blob';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import { useHeicBlob } from '@/hooks/use-heic-url';
import { safeHttpUrl } from '@/lib/safe-url';
import { getIframeSandbox } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { isHeicFile } from '@/lib/utils/heic-convert';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { SANDBOX_PORTS } from '@kortix/sdk/platform-client';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileIcon,
  FileText,
  FileWarning,
  Globe,
  Loader2,
  Music,
} from 'lucide-react';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageRenderer } from './image-renderer';
import { VideoRenderer } from './video-renderer';

// ── Lazy-load heavy renderers ──────────────────────────────────────────────

const PdfRenderer = lazy(() => import('./pdf/pdf-renderer').then((m) => ({ default: m.PdfRenderer })));
const CsvRenderer = lazy(() =>
  import('./csv/csv-renderer').then((m) => ({ default: m.CsvRenderer })),
);
const XlsxRenderer = lazy(() =>
  import('./xlsx-renderer').then((m) => ({ default: m.XlsxRenderer })),
);
const DocxRenderer = lazy(() =>
  import('./docx/docx-renderer').then((m) => ({ default: m.DocxRenderer })),
);
const PptxRenderer = lazy(() =>
  import('./pptx-renderer').then((m) => ({ default: m.PptxRenderer })),
);

// ── Extension regexes ──────────────────────────────────────────────────────

export const SHOW_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?|heic|heif)$/i;
export const SHOW_VIDEO_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)$/i;
export const SHOW_AUDIO_EXT_RE = /\.(mp3|wav|ogg|aac|flac|m4a|opus|wma)$/i;
export const SHOW_PDF_EXT_RE = /\.pdf$/i;
export const SHOW_CSV_EXT_RE = /\.(csv|tsv)$/i;
export const SHOW_XLSX_EXT_RE = /\.xlsx?$/i;
export const SHOW_DOCX_EXT_RE = /\.docx$/i;
export const SHOW_PPTX_EXT_RE = /\.(pptx|ppt)$/i;
export const SHOW_HTML_EXT_RE = /\.(html?|htm)$/i;

// ── Helpers ────────────────────────────────────────────────────────────────

export function showFavicon(url: string): string | null {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`;
  } catch {
    return null;
  }
}

export function showDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

export function showAspectRatioToCSS(ar: string | undefined): string | undefined {
  if (!ar || ar === 'auto') return undefined;
  const [w, h] = ar.split(':').map(Number);
  if (w && h) return `${w}/${h}`;
  return undefined;
}

function isLocalSandboxFilePath(value: string): boolean {
  if (!value) return false;
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  return value.startsWith('/');
}

/** Auto-detect file category from extension — used when type='file' */
function getShowFileCategory(filePath: string): string {
  if (SHOW_IMAGE_EXT_RE.test(filePath)) return 'image';
  if (SHOW_VIDEO_EXT_RE.test(filePath)) return 'video';
  if (SHOW_AUDIO_EXT_RE.test(filePath)) return 'audio';
  if (SHOW_PDF_EXT_RE.test(filePath)) return 'pdf';
  if (SHOW_CSV_EXT_RE.test(filePath)) return 'csv';
  if (SHOW_XLSX_EXT_RE.test(filePath)) return 'xlsx';
  if (SHOW_DOCX_EXT_RE.test(filePath)) return 'docx';
  if (SHOW_PPTX_EXT_RE.test(filePath)) return 'pptx';
  if (SHOW_HTML_EXT_RE.test(filePath)) return 'html-file';
  return 'file';
}

/** Types loaded via useBinaryBlob (/file/raw, direct binary fetch) */
const BLOB_TYPES = new Set(['image', 'video', 'audio', 'docx', 'pptx']);

function RendererFallback({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center', className || 'h-[420px]')}>
      <Loader2 className="text-muted-foreground/40 h-4 w-4 animate-spin" />
    </div>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <div className="flex h-[300px] flex-col items-center justify-center gap-2 p-8 text-center">
      <FileWarning className="text-muted-foreground/30 h-6 w-6" />
      <p className="text-muted-foreground/60 max-w-sm text-xs">{message}</p>
    </div>
  );
}

function FileCard({ title, fileName, path }: { title?: string; fileName: string; path: string }) {
  return (
    <div className="flex items-center gap-4 px-5 py-5">
      <div className="bg-muted/20 flex size-12 items-center justify-center rounded-xl">
        <FileText className="text-muted-foreground/40 size-6" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{title || fileName}</div>
        <div className="text-muted-foreground/50 mt-0.5 truncate font-mono text-xs">{path}</div>
      </div>
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface ShowContentProps {
  type: string;
  title?: string;
  description?: string;
  path?: string;
  url?: string;
  content?: string;
  language?: string;
  aspectRatio?: string;
  /** Optional: render a proxied localhost iframe. Caller provides this component. */
  LocalhostPreview?: React.ComponentType<{ url: string; label?: string }>;
  /**
   * Fill the available height (side-panel "Actions" surface) instead of the
   * compact fixed-height card used inline in the chat column. Media stretches
   * to fill; text/code scroll internally rather than capping at a fixed height.
   */
  fill?: boolean;
  /**
   * Optional: report load status up to the parent so a single-item `show` whose
   * artifact failed to load (renamed/deleted file → 404) can be hidden instead
   * of rendering a broken card. Fired for fetch-backed types (image/video/
   * audio/pdf/csv/docx/pptx) and forwarded from the generic-file renderer.
   */
  onStatusChange?: (status: 'loading' | 'ready' | 'error') => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function ShowContentRenderer({
  type,
  title = '',
  description = '',
  path = '',
  url = '',
  content = '',
  language = '',
  aspectRatio = '',
  LocalhostPreview,
  fill = false,
  onStatusChange,
}: ShowContentProps) {
  const arCSS = showAspectRatioToCSS(aspectRatio);

  // ── Height presets — fill the panel vs. the compact inline card ──
  // `mediaH`   → visual media (image/video/pdf/sheets/docs/generic file)
  // `textWrap` → scrollable text/code/markdown surfaces
  const mediaH = fill ? 'h-full' : 'h-[420px]';
  const textWrap = fill ? 'px-5 py-5 h-full overflow-auto' : 'px-5 py-5 max-h-96 overflow-auto';
  // In fill mode the show card owns its own internal scroll, so we drop the
  // `data-scrollable` hook the panel uses to uncap inline content (otherwise the
  // panel body would scroll the whole card instead of the content within it).
  const scrollableAttr = fill ? undefined : true;

  // ── Resolve effective type: 'file' auto-detects from extension ──
  const effectiveType = useMemo(() => {
    if (type === 'file' && path) return getShowFileCategory(path);
    return type;
  }, [type, path]);

  // ── Category flags ──
  const isImage = effectiveType === 'image';
  const isVideo = effectiveType === 'video';
  const isAudio = effectiveType === 'audio';
  const isPdf = effectiveType === 'pdf';
  const isCsv = effectiveType === 'csv';
  const isXlsx = effectiveType === 'xlsx';
  const isDocx = effectiveType === 'docx';
  const isPptx = effectiveType === 'pptx';
  const isCode = effectiveType === 'code';
  const isMarkdown = effectiveType === 'markdown';
  const isText = effectiveType === 'text';
  const isHtml = effectiveType === 'html';
  const isHtmlFile = effectiveType === 'html-file';
  const hasLocalhostUrl = !!parseLocalhostUrl(url) && !isAppRouteUrl(url);
  const safeExternalUrl = safeHttpUrl(url);

  // ── Sandbox file path normalization ──
  // The show tool backend resolves paths to absolute (e.g. /workspace/foo.png).
  // The /file/raw endpoint on kortix-master accepts absolute paths and validates
  // them against ALLOWED_ROOTS (/workspace, /opt, /tmp, /home).
  // Keep the path absolute — do NOT strip /workspace/ prefix.
  const isLocalPath = path ? isLocalSandboxFilePath(path) : false;
  const sandboxPath = useMemo(() => {
    if (!path || !isLocalPath) return null;
    return path;
  }, [path, isLocalPath]);

  const fileName = useMemo(() => path.split('/').pop() || '', [path]);

  // ═════════════════════════════════════════════════════════════════════════
  // Data loading hooks — called unconditionally (React rules), gated by path
  // ═════════════════════════════════════════════════════════════════════════

  // Binary blob: ONE hook for image, video, audio, pdf, docx, pptx
  // Uses /file/raw endpoint (direct binary fetch via authenticatedFetch),
  // NOT the SDK text-read endpoint. More reliable for binary content.
  const needsBlob = BLOB_TYPES.has(effectiveType) && !!sandboxPath;
  const blobFilePath = needsBlob ? sandboxPath : null;
  const {
    blobUrl,
    blob: rawBlob,
    isLoading: blobLoading,
    error: blobError,
  } = useBinaryBlob(blobFilePath);

  // HEIC conversion — converts the raw blob to renderable JPEG
  const isHeic = isImage && isHeicFile(fileName);
  const { url: heicImageUrl, isConverting: heicConverting } = useHeicBlob(
    isHeic ? rawBlob : null,
    fileName,
  );

  // PDF: base64 content via SDK, decoded by PdfRenderer into a Blob URL.
  const pdfLoadPath = isPdf && sandboxPath ? sandboxPath : null;
  const {
    data: pdfData,
    isLoading: pdfLoading,
    error: pdfError,
  } = useFileContent(pdfLoadPath, { enabled: !!pdfLoadPath });

  // CSV/TSV: text content via SDK
  const csvLoadPath = isCsv && sandboxPath ? sandboxPath : null;
  const { data: csvData, isLoading: csvLoading } = useFileContent(csvLoadPath, {
    enabled: !!csvLoadPath,
  });

  // HTML blob URL (inline content, no SDK call)
  const htmlBlobUrl = useMemo(() => {
    if (!isHtml || !content) return null;
    const blob = new Blob([content], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [isHtml, content]);

  // Error fallback for FileContentRenderer (used for generic 'file' type)
  const fileErrorFallback = useCallback(
    (_error: string, fp: string) => {
      const name = fp.split('/').pop() || fp;
      return (
        <div className="flex h-full items-center gap-4 px-5 py-5">
          <div className="bg-muted/20 flex size-12 items-center justify-center rounded-xl">
            <FileText className="text-muted-foreground/40 size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm font-medium">{title || name}</div>
            <div className="text-muted-foreground/50 mt-0.5 truncate font-mono text-xs">{path}</div>
          </div>
        </div>
      );
    },
    [title, path],
  );

  // ═════════════════════════════════════════════════════════════════════════
  // Load-status reporting — lets the parent (ShowTool) hide a dead reference
  // (renamed/deleted file → 404) instead of rendering a broken card.
  // `null` = a child renderer owns the reporting (the generic-file branch
  // forwards `onStatusChange` straight to FileContentRenderer below). The branch
  // selection here mirrors the render cascade further down.
  // ═════════════════════════════════════════════════════════════════════════
  const ownStatus = useMemo<'loading' | 'ready' | 'error' | null>(() => {
    // Generic file → FileContentRenderer reports via its own onStatusChange.
    if (effectiveType === 'file' && path && sandboxPath) return null;
    // Binary/media types backed by useBinaryBlob.
    if ((isImage || isVideo || isAudio || isDocx || isPptx) && path) {
      if (blobError) return 'error';
      if (blobLoading || (isImage && heicConverting)) return 'loading';
      return 'ready';
    }
    // PDF backed by useFileContent (base64).
    if (isPdf && path) {
      if (pdfError) return 'error';
      if (pdfLoading) return 'loading';
      return 'ready';
    }
    // CSV backed by useFileContent (text).
    if (isCsv && path) return csvLoading ? 'loading' : 'ready';
    // Everything else (url link, xlsx self-loading, code/markdown/text/html/
    // error, localhost/html iframe, fallback) renders without a fetch we track.
    return 'ready';
  }, [
    effectiveType,
    path,
    sandboxPath,
    isImage,
    isVideo,
    isAudio,
    isDocx,
    isPptx,
    isPdf,
    isCsv,
    blobError,
    blobLoading,
    heicConverting,
    pdfError,
    pdfLoading,
    csvLoading,
  ]);

  useEffect(() => {
    if (ownStatus !== null) onStatusChange?.(ownStatus);
  }, [ownStatus, onStatusChange]);

  // ═════════════════════════════════════════════════════════════════════════
  // Localhost URL → proxied iframe (caller provides the component)
  // ═════════════════════════════════════════════════════════════════════════
  if (hasLocalhostUrl && LocalhostPreview) {
    return <LocalhostPreview url={url} label={title || description || undefined} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HTML file path → render via static file server (port 3211) as proxied iframe
  // Handles: type='file' with .html/.htm extension, OR type='html' with path only
  // ═════════════════════════════════════════════════════════════════════════
  if ((isHtmlFile || (isHtml && !content)) && sandboxPath && LocalhostPreview) {
    const staticPort = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);
    const normalizedPath = toSandboxAbsolutePath(sandboxPath);
    const encodedPath = normalizedPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const staticUrl = `http://localhost:${staticPort}/open?path=/${encodedPath}`;
    return <LocalhostPreview url={staticUrl} label={title || fileName || undefined} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // URL / Link — hero link card with favicon
  // ═════════════════════════════════════════════════════════════════════════
  if (effectiveType === 'url' && url) {
    if (!safeExternalUrl) {
      return (
        <div className="px-5 py-4">
          <div className="text-muted-foreground flex items-center gap-2 truncate font-mono text-xs">
            <Globe className="size-3.5 shrink-0" />
            {url}
          </div>
        </div>
      );
    }
    const favicon = showFavicon(safeExternalUrl);
    const domain = showDomain(safeExternalUrl);
    return (
      <div className={cn('px-5 py-5', fill && 'flex h-full items-center')}>
        <a
          href={safeExternalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group border-border/30 bg-muted/5 hover:bg-muted/20 flex w-full items-center gap-4 rounded-2xl border p-4 transition-colors"
        >
          <div className="bg-muted/30 flex size-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg">
            {favicon ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={favicon}
                alt=""
                className="size-6 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Globe className="text-muted-foreground/50 size-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-foreground group-hover:text-primary truncate text-sm font-medium transition-colors">
              {title || domain}
            </div>
            <div className="text-muted-foreground/60 mt-0.5 truncate font-mono text-xs">
              {domain}
            </div>
            {description && (
              <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">{description}</div>
            )}
          </div>
          <ExternalLink className="text-muted-foreground/30 group-hover:text-muted-foreground/60 size-4 flex-shrink-0 transition-colors" />
        </a>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Image — loaded via useBinaryBlob → blobUrl → ImageRenderer
  // HEIC images go through an extra conversion step (blob → JPEG → blobUrl)
  // ═════════════════════════════════════════════════════════════════════════
  if (isImage && path) {
    if (blobLoading || heicConverting) return <RendererFallback className={mediaH} />;
    if (blobError) return <LoadError message={blobError} />;
    // HEIC: use the converted JPEG URL
    const imageUrl = isHeic ? heicImageUrl : blobUrl;
    if (imageUrl) {
      return (
        <div className={mediaH}>
          <ImageRenderer url={imageUrl} fileName={fileName} />
        </div>
      );
    }
    return <FileCard title={title} fileName={fileName} path={path} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Video — loaded via useBinaryBlob → blobUrl → VideoRenderer
  // ═════════════════════════════════════════════════════════════════════════
  if (isVideo && path) {
    if (blobLoading) return <RendererFallback className={mediaH} />;
    if (blobError) return <LoadError message={blobError} />;
    if (blobUrl) {
      return (
        <div className={mediaH}>
          <VideoRenderer url={blobUrl} />
        </div>
      );
    }
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Audio — loaded via useBinaryBlob → blobUrl → <audio>
  // ═════════════════════════════════════════════════════════════════════════
  if (isAudio && path) {
    if (blobLoading) return <RendererFallback className={mediaH} />;
    if (blobError) return <LoadError message={blobError} />;
    if (blobUrl) {
      return (
        <div
          className={cn(
            'flex flex-col items-center justify-center gap-5',
            fill ? 'h-full' : 'py-10',
          )}
        >
          <div className="bg-muted/50 flex h-14 w-14 items-center justify-center rounded-2xl">
            <Music className="text-muted-foreground/40 size-6" />
          </div>
          {(title || fileName) && (
            <p className="text-muted-foreground/60 text-xs">{title || fileName}</p>
          )}
          <audio controls src={blobUrl} className="w-full max-w-sm" preload="metadata" />
        </div>
      );
    }
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PDF — loaded via useFileContent base64 → atob → Blob URL → native PDF viewer
  // ═════════════════════════════════════════════════════════════════════════
  if (isPdf && path) {
    if (pdfLoading) return <RendererFallback className={mediaH} />;
    if (pdfError)
      return (
        <LoadError message={pdfError instanceof Error ? pdfError.message : String(pdfError)} />
      );
    if (pdfData?.content) {
      return (
        <Suspense fallback={<RendererFallback className={mediaH} />}>
          <div className={mediaH}>
            <PdfRenderer fileContent={pdfData.content} className="h-full" />
          </div>
        </Suspense>
      );
    }
    return <FileCard title={title || 'PDF Document'} fileName={fileName} path={path} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CSV / TSV — loaded via useFileContent → text → CsvRenderer
  // ═════════════════════════════════════════════════════════════════════════
  if (isCsv && path) {
    if (csvLoading) return <RendererFallback className={mediaH} />;
    if (csvData?.content) {
      return (
        <Suspense fallback={<RendererFallback className={mediaH} />}>
          <div className={cn(mediaH, 'overflow-hidden')}>
            <CsvRenderer content={csvData.content} className="h-full" />
          </div>
        </Suspense>
      );
    }
    return <FileCard title={title} fileName={fileName} path={path} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // XLSX — XlsxRenderer (self-loading via filePath prop)
  // ═════════════════════════════════════════════════════════════════════════
  if (isXlsx && path && sandboxPath) {
    return (
      <Suspense fallback={<RendererFallback className={mediaH} />}>
        <div className={cn(mediaH, 'overflow-hidden')}>
          <XlsxRenderer filePath={sandboxPath} fileName={fileName} className="h-full" />
        </div>
      </Suspense>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DOCX — loaded via useBinaryBlob → rawBlob → DocxRenderer
  // ═════════════════════════════════════════════════════════════════════════
  if (isDocx && path) {
    if (blobLoading) return <RendererFallback className={mediaH} />;
    if (blobError) return <LoadError message={blobError} />;
    if (rawBlob) {
      return (
        <Suspense fallback={<RendererFallback className={mediaH} />}>
          <div className={cn(mediaH, 'overflow-hidden')}>
            <DocxRenderer blob={rawBlob} className="h-full" />
          </div>
        </Suspense>
      );
    }
    return <FileCard title={title || 'Word Document'} fileName={fileName} path={path} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PPTX — loaded via useBinaryBlob → rawBlob → PptxRenderer
  // ═════════════════════════════════════════════════════════════════════════
  if (isPptx && path) {
    if (blobLoading) return <RendererFallback className={mediaH} />;
    if (blobError) return <LoadError message={blobError} />;
    if (rawBlob) {
      return (
        <Suspense fallback={<RendererFallback className={mediaH} />}>
          <div className={cn(mediaH, 'overflow-hidden')}>
            <PptxRenderer
              blob={rawBlob}
              binaryUrl={blobUrl}
              filePath={sandboxPath || ''}
              fileName={fileName}
              className="h-full"
            />
          </div>
        </Suspense>
      );
    }
    return <FileCard title={title || 'PowerPoint Presentation'} fileName={fileName} path={path} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Generic file (json, yaml, ts, py, etc.) → FileContentRenderer
  // FileContentRenderer handles text/code detection, syntax highlighting,
  // and binary fallbacks. Works great for text files via SDK text-read.
  // ═════════════════════════════════════════════════════════════════════════
  if (effectiveType === 'file' && path && sandboxPath) {
    return (
      <div className={mediaH}>
        <FileContentRenderer
          filePath={sandboxPath}
          showHeader={false}
          className="h-full"
          errorFallback={fileErrorFallback}
          onStatusChange={onStatusChange}
        />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Code — syntax highlighted
  // ═════════════════════════════════════════════════════════════════════════
  if (isCode && content) {
    return (
      <div className={textWrap}>
        <CodeHighlight code={content} language={language || 'text'} />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Markdown — rendered
  // ═════════════════════════════════════════════════════════════════════════
  if (isMarkdown && content) {
    return (
      <div data-scrollable={scrollableAttr} className={textWrap}>
        <UnifiedMarkdown content={content} />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Text — render as markdown (supports formatting, links, lists etc.)
  // ═════════════════════════════════════════════════════════════════════════
  if (isText && content) {
    return (
      <div data-scrollable={scrollableAttr} className={textWrap}>
        <UnifiedMarkdown content={content} />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HTML — sandboxed iframe
  // ═════════════════════════════════════════════════════════════════════════
  if (isHtml && content && htmlBlobUrl) {
    return (
      <div className={cn('overflow-hidden', fill && 'h-full')}>
        <iframe
          src={htmlBlobUrl}
          title={title || 'HTML Preview'}
          className="w-full border-0 bg-white"
          style={
            fill
              ? { height: '100%' }
              : { height: arCSS ? undefined : '540px', aspectRatio: arCSS || undefined }
          }
          sandbox={getIframeSandbox({ isolateHtmlPreview: true })}
        />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Error
  // ═════════════════════════════════════════════════════════════════════════
  if (effectiveType === 'error' && content) {
    return (
      <div className={cn('px-5 py-4', fill && 'flex h-full items-center')}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-red-500" />
          <p className="text-foreground text-sm whitespace-pre-wrap">
            <TextWithPaths text={content} />
          </p>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Fallback — unknown type
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div className={cn('px-5 py-4', fill && 'h-full overflow-auto')}>
      {content && (
        <div
          data-scrollable={scrollableAttr}
          className={fill ? undefined : 'max-h-96 overflow-auto'}
        >
          <UnifiedMarkdown content={content} />
        </div>
      )}
      {path && !content && (
        <div className="text-muted-foreground flex items-center gap-2 truncate font-mono text-xs">
          <FileIcon className="size-3.5 shrink-0" />
          {path}
        </div>
      )}
      {safeExternalUrl && !content && (
        <a
          href={safeExternalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary flex items-center gap-1.5 truncate font-mono text-xs hover:underline"
        >
          <ExternalLink className="size-3.5" />
          {safeExternalUrl}
        </a>
      )}
      {url && !safeExternalUrl && !content && (
        <div className="text-muted-foreground flex items-center gap-2 truncate font-mono text-xs">
          <Globe className="size-3.5 shrink-0" />
          {url}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ShowCarousel — multi-item carousel for items[] mode
// ═══════════════════════════════════════════════════════════════════════════

export interface ShowCarouselItem {
  type: string;
  title?: string;
  description?: string;
  path?: string;
  url?: string;
  content?: string;
  language?: string;
  aspect_ratio?: string;
}

export interface ShowCarouselProps {
  items: ShowCarouselItem[];
  /** Optional: component for rendering proxied localhost iframes */
  LocalhostPreview?: React.ComponentType<{ url: string; label?: string }>;
  /** Called when the active carousel item changes — lets parents track the current item for "Open File" etc. */
  onIndexChange?: (index: number) => void;
  /** Fill the available height (side-panel surface) instead of a fixed-height card. */
  fill?: boolean;
}

const SHOW_TYPE_LABELS: Record<string, string> = {
  file: 'File',
  image: 'Image',
  url: 'URL',
  text: 'Text',
  error: 'Error',
  video: 'Video',
  audio: 'Audio',
  code: 'Code',
  markdown: 'Markdown',
  pdf: 'PDF',
  html: 'HTML',
  csv: 'CSV',
  xlsx: 'Sheet',
  docx: 'Doc',
  pptx: 'Slides',
};

// Document formats show just their uppercase extension (PDF, PPTX, DOCX, XLSX…)
// instead of a filename pill. Everything else (code/text/html/css/tsx…) shows its basename.
const SHOW_DOC_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?)$/i;
const SHOW_DOC_TYPE_RE = /^(pdf|docx?|pptx?|xlsx?)$/i;

/** Document extension for a carousel item (pdf/doc/ppt/xls families), or null. */
function getShowDocExt(item: ShowCarouselItem): string | null {
  const match = item.path?.match(SHOW_DOC_EXT_RE);
  if (match) return match[1].toLowerCase();
  const type = item.type ?? '';
  if (SHOW_DOC_TYPE_RE.test(type)) return type.toLowerCase();
  return null;
}

function truncateLabel(value: string, max = 18): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Short pill label for a carousel segment — port, doc extension, filename, domain, or type. */
export function getShowCarouselItemLabel(item: ShowCarouselItem): string {
  const localhost = item.url ? parseLocalhostUrl(item.url) : null;
  if (localhost && !isAppRouteUrl(item.url)) return `:${localhost.port}`;

  const docExt = getShowDocExt(item);
  if (docExt) return docExt.toUpperCase();

  if (item.title?.trim()) return truncateLabel(item.title.trim());

  if (item.url) {
    const external = safeHttpUrl(item.url);
    if (external) return truncateLabel(showDomain(external));
  }

  if (item.path) {
    const base = item.path.split('/').filter(Boolean).pop();
    if (base) return truncateLabel(base);
  }

  return SHOW_TYPE_LABELS[item.type] ?? truncateLabel(item.type || 'Item');
}

function getShowCarouselItemAriaLabel(
  item: ShowCarouselItem,
  index: number,
  total: number,
): string {
  const parts = [`Item ${index + 1} of ${total}`];
  if (item.title) parts.push(item.title);
  else parts.push(getShowCarouselItemLabel(item));
  if (item.type) parts.push(item.type);
  return parts.join(' · ');
}

export function ShowCarousel({
  items,
  LocalhostPreview,
  onIndexChange,
  fill = false,
}: ShowCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const count = items.length;
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const labels = useMemo(() => items.map(getShowCarouselItemLabel), [items]);

  const goTo = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(idx, count - 1));
      setCurrentIndex(clamped);
      onIndexChange?.(clamped);
    },
    [count, onIndexChange],
  );

  const prev = useCallback(() => goTo(currentIndex - 1), [goTo, currentIndex]);
  const next = useCallback(() => goTo(currentIndex + 1), [goTo, currentIndex]);

  useEffect(() => {
    segmentRefs.current[currentIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [currentIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          el.closest('.cm-editor') ||
          el.closest('.ProseMirror'))
      ) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next]);

  const currentItem = items[currentIndex];
  if (!currentItem) return null;

  return (
    <div className={cn(fill && 'flex h-full flex-col')}>
      <div className={cn(fill ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-[420px]')}>
        <ShowContentRenderer
          type={currentItem.type}
          title={currentItem.title}
          description={currentItem.description}
          path={currentItem.path}
          url={currentItem.url}
          content={currentItem.content}
          language={currentItem.language}
          aspectRatio={currentItem.aspect_ratio}
          LocalhostPreview={LocalhostPreview}
          fill={fill}
        />
      </div>

      {count > 1 && (
        <div className="border-border flex shrink-0 items-center gap-2 border-t px-2 py-1.5 pr-3.5">
          <div className="flex shrink-0 items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={prev}
              className="hit-area-2 hit-area-r-0 transition-transform active:scale-[0.96]"
              disabled={currentIndex === 0}
              aria-label="Previous item"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={next}
              className="hit-area-2 hit-area-l-0 transition-transform active:scale-[0.96]"
              disabled={currentIndex >= count - 1}
              aria-label="Next item"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <FadedScrollArea
            orientation="horizontal"
            fadeColor="from-background"
            className="min-w-0 flex-1 overscroll-x-contain"
          >
            <div className="flex w-max min-w-0 items-center gap-1">
              {items.map((item, i) => {
                const label = labels[i] ?? 'Item';
                const isPortLabel = label.startsWith(':');
                return (
                  <button
                    key={i}
                    ref={(el) => {
                      segmentRefs.current[i] = el;
                    }}
                    type="button"
                    onClick={() => goTo(i)}
                    aria-label={getShowCarouselItemAriaLabel(item, i, count)}
                    aria-current={i === currentIndex ? 'true' : undefined}
                    className={cn(
                      'shrink-0 rounded-md px-2 py-1 text-xs font-medium',
                      'transition-[background-color,color,transform] active:scale-[0.96]',
                      i === currentIndex
                        ? 'bg-foreground/10 text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span className={cn(isPortLabel && 'tabular-nums')}>{label}</span>
                  </button>
                );
              })}
            </div>
          </FadedScrollArea>

          <span className="text-muted-foreground shrink-0 pl-1 text-xs tabular-nums">
            {currentIndex + 1}
            <span className="text-muted-foreground/40">/</span>
            {count}
          </span>
        </div>
      )}
    </div>
  );
}
