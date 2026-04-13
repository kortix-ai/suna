'use client';

/**
 * ShowContentRenderer — THE single source-of-truth for rendering
 * show tool content inline in the session chat and side panel.
 *
 * Architecture:
 *  Binary files (image, video, audio, pdf, docx, pptx)
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

import React, { useCallback, useMemo, useState, lazy, Suspense } from 'react';
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
import { cn } from '@/lib/utils';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import { useBinaryBlob } from '@/features/files/hooks/use-binary-blob';
import { CodeHighlight, UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { TextWithPaths } from '@/components/common/clickable-path';
import { ImageRenderer } from './image-renderer';
import { VideoRenderer } from './video-renderer';
import { FileContentRenderer } from '@/features/files/components/file-content-renderer';
import { SANDBOX_PORTS } from '@/lib/platform-client';
import { isHeicFile } from '@/lib/utils/heic-convert';
import { useHeicBlob } from '@/hooks/use-heic-url';
import { getIframeSandbox } from '@/lib/security/iframe-sandbox';

// ── Lazy-load heavy renderers ──────────────────────────────────────────────

const PdfRenderer = lazy(() =>
  import('./pdf-renderer').then((m) => ({ default: m.PdfRenderer })),
);
const CsvRenderer = lazy(() =>
  import('./csv-renderer').then((m) => ({ default: m.CsvRenderer })),
);
const XlsxRenderer = lazy(() =>
  import('./xlsx-renderer').then((m) => ({ default: m.XlsxRenderer })),
);
const DocxRenderer = lazy(() =>
  import('./docx-renderer').then((m) => ({ default: m.DocxRenderer })),
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
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`; }
  catch { return null; }
}

export function showDomain(url: string): string {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url; }
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

/** Ensure a sandbox file path starts with /workspace/ for the static file server. */
function ensureWorkspacePath(filePath: string): string {
  if (filePath.startsWith('/workspace/')) return filePath;
  return '/workspace/' + filePath.replace(/^\/+/, '');
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
const BLOB_TYPES = new Set(['image', 'video', 'audio', 'pdf', 'docx', 'pptx']);

function RendererFallback() {
  return (
    <div className="flex items-center justify-center h-[420px]">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
    </div>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[300px] gap-2 p-8 text-center">
      <FileWarning className="h-6 w-6 text-muted-foreground/30" />
      <p className="text-xs text-muted-foreground/60 max-w-sm">{message}</p>
    </div>
  );
}

function FileCard({ title, fileName, path }: { title?: string; fileName: string; path: string }) {
  return (
    <div className="flex items-center gap-4 px-5 py-5">
      <div className="flex items-center justify-center size-12 rounded-xl bg-muted/20">
        <FileText className="size-6 text-muted-foreground/40" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{title || fileName}</div>
        <div className="text-xs text-muted-foreground/50 font-mono truncate mt-0.5">{path}</div>
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
}: ShowContentProps) {
  const arCSS = showAspectRatioToCSS(aspectRatio);

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
  const { blobUrl, blob: rawBlob, isLoading: blobLoading, error: blobError } = useBinaryBlob(blobFilePath);

  // HEIC conversion — converts the raw blob to renderable JPEG
  const isHeic = isImage && isHeicFile(fileName);
  const { url: heicImageUrl, isConverting: heicConverting } = useHeicBlob(
    isHeic ? rawBlob : null,
    fileName,
  );

  // CSV/TSV: text content via SDK
  const csvLoadPath = isCsv && sandboxPath ? sandboxPath : null;
  const { data: csvData, isLoading: csvLoading } = useFileContent(
    csvLoadPath,
    { enabled: !!csvLoadPath },
  );

  // HTML blob URL (inline content, no SDK call)
  const htmlBlobUrl = useMemo(() => {
    if (!isHtml || !content) return null;
    const blob = new Blob([content], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [isHtml, content]);

  // Error fallback for FileContentRenderer (used for generic 'file' type)
  const fileErrorFallback = useCallback((_error: string, fp: string) => {
    const name = fp.split('/').pop() || fp;
    return (
      <div className="flex items-center gap-4 px-5 py-5 h-full">
        <div className="flex items-center justify-center size-12 rounded-xl bg-muted/20">
          <FileText className="size-6 text-muted-foreground/40" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{title || name}</div>
          <div className="text-xs text-muted-foreground/50 font-mono truncate mt-0.5">{path}</div>
        </div>
      </div>
    );
  }, [title, path]);

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
    const normalizedPath = ensureWorkspacePath(sandboxPath);
    const encodedPath = normalizedPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const staticUrl = `http://localhost:${staticPort}/open?path=/${encodedPath}`;
    return <LocalhostPreview url={staticUrl} label={title || fileName || undefined} />;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // URL / Link — hero link card with favicon
  // ═════════════════════════════════════════════════════════════════════════
  if (effectiveType === 'url' && url) {
    const favicon = showFavicon(url);
    const domain = showDomain(url);
    return (
      <div className="px-5 py-5">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-4 p-4 rounded-xl border border-border/30 bg-muted/5 hover:bg-muted/20 transition-colors"
        >
          <div className="flex items-center justify-center size-10 rounded-lg bg-muted/30 flex-shrink-0 overflow-hidden">
            {favicon ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={favicon}
                alt=""
                className="size-6 rounded"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <Globe className="size-5 text-muted-foreground/50" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground group-hover:text-primary transition-colors truncate">
              {title || domain}
            </div>
            <div className="text-xs text-muted-foreground/60 font-mono truncate mt-0.5">
              {domain}
            </div>
            {description && (
              <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {description}
              </div>
            )}
          </div>
          <ExternalLink className="size-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors flex-shrink-0" />
        </a>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Image — loaded via useBinaryBlob → blobUrl → ImageRenderer
  // HEIC images go through an extra conversion step (blob → JPEG → blobUrl)
  // ═════════════════════════════════════════════════════════════════════════
  if (isImage && path) {
    if (blobLoading || heicConverting) return <RendererFallback />;
    if (blobError) return <LoadError message={blobError} />;
    // HEIC: use the converted JPEG URL
    const imageUrl = isHeic ? heicImageUrl : blobUrl;
    if (imageUrl) {
      return (
        <div className="h-[420px]">
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
    if (blobLoading) return <RendererFallback />;
    if (blobError) return <LoadError message={blobError} />;
    if (blobUrl) {
      return (
        <div className="h-[420px]">
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
    if (blobLoading) return <RendererFallback />;
    if (blobError) return <LoadError message={blobError} />;
    if (blobUrl) {
      return (
        <div className="flex flex-col items-center justify-center py-10 gap-5">
          <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
            <Music className="size-6 text-muted-foreground/40" />
          </div>
          {(title || fileName) && (
            <p className="text-xs text-muted-foreground/60">{title || fileName}</p>
          )}
          <audio controls src={blobUrl} className="w-full max-w-sm" preload="metadata" />
        </div>
      );
    }
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PDF — loaded via useBinaryBlob → blobUrl → PdfRenderer (with zoom)
  // ═════════════════════════════════════════════════════════════════════════
  if (isPdf && path) {
    if (blobLoading) return <RendererFallback />;
    if (blobError) return <LoadError message={blobError} />;
    if (rawBlob) {
      return (
        <Suspense fallback={<RendererFallback />}>
          <div className="h-[420px]">
            <PdfRenderer blob={rawBlob} className="h-full" />
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
    if (csvLoading) return <RendererFallback />;
    if (csvData?.content) {
      return (
        <Suspense fallback={<RendererFallback />}>
          <div className="h-[420px] overflow-hidden">
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
      <Suspense fallback={<RendererFallback />}>
        <div className="h-[420px] overflow-hidden">
          <XlsxRenderer filePath={sandboxPath} fileName={fileName} className="h-full" />
        </div>
      </Suspense>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DOCX — loaded via useBinaryBlob → rawBlob → DocxRenderer
  // ═════════════════════════════════════════════════════════════════════════
  if (isDocx && path) {
    if (blobLoading) return <RendererFallback />;
    if (blobError) return <LoadError message={blobError} />;
    if (rawBlob) {
      return (
        <Suspense fallback={<RendererFallback />}>
          <div className="h-[420px] overflow-hidden">
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
    if (blobLoading) return <RendererFallback />;
    if (blobError) return <LoadError message={blobError} />;
    if (rawBlob) {
      return (
        <Suspense fallback={<RendererFallback />}>
          <div className="h-[420px] overflow-hidden">
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
      <div className="h-[420px]">
        <FileContentRenderer
          filePath={sandboxPath}
          showHeader={false}
          className="h-full"
          errorFallback={fileErrorFallback}
        />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Code — syntax highlighted
  // ═════════════════════════════════════════════════════════════════════════
  if (isCode && content) {
    return (
      <div className="px-5 py-5 max-h-96 overflow-auto">
        <CodeHighlight
          code={content}
          language={language || 'text'}
        />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Markdown — rendered
  // ═════════════════════════════════════════════════════════════════════════
  if (isMarkdown && content) {
    return (
      <div data-scrollable className="px-5 py-5 max-h-96 overflow-auto">
        <UnifiedMarkdown content={content} />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Text — render as markdown (supports formatting, links, lists etc.)
  // ═════════════════════════════════════════════════════════════════════════
  if (isText && content) {
    return (
      <div data-scrollable className="px-5 py-5 max-h-96 overflow-auto">
        <UnifiedMarkdown content={content} />
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HTML — sandboxed iframe
  // ═════════════════════════════════════════════════════════════════════════
  if (isHtml && content && htmlBlobUrl) {
    return (
      <div className="overflow-hidden">
        <iframe
          src={htmlBlobUrl}
          title={title || 'HTML Preview'}
          className="w-full border-0 bg-white"
          style={{ height: arCSS ? undefined : '540px', aspectRatio: arCSS || undefined }}
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
      <div className="px-5 py-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-4 flex-shrink-0 mt-0.5 text-red-500" />
          <p className="text-sm text-foreground whitespace-pre-wrap"><TextWithPaths text={content} /></p>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Fallback — unknown type
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div className="px-5 py-4">
      {content && (
        <div data-scrollable className="max-h-96 overflow-auto">
          <UnifiedMarkdown content={content} />
        </div>
      )}
      {path && !content && (
        <div className="flex items-center gap-2 text-muted-foreground font-mono text-xs truncate">
          <FileIcon className="size-3.5 shrink-0" />
          {path}
        </div>
      )}
      {url && !content && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary font-mono text-xs truncate hover:underline flex items-center gap-1.5">
          <ExternalLink className="size-3.5" />
          {url}
        </a>
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
}

export function ShowCarousel({ items, LocalhostPreview, onIndexChange }: ShowCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const count = items.length;

  const goTo = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, count - 1));
    setCurrentIndex(clamped);
    onIndexChange?.(clamped);
  }, [count, onIndexChange]);

  const prev = useCallback(() => goTo(currentIndex - 1), [goTo, currentIndex]);
  const next = useCallback(() => goTo(currentIndex + 1), [goTo, currentIndex]);

  const currentItem = items[currentIndex];
  if (!currentItem) return null;

  const itemTitle = currentItem.title || currentItem.type || '';

  return (
    <div>
      {/* ── Content area — stable min height prevents jarring jumps ── */}
      <div className="min-h-[420px]">
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
        />
      </div>

      {/* ── Navigation bar ── */}
      {count > 1 && (
        <div className="flex items-center gap-3 px-5 py-3 border-t border-border/15">
          {/* Prev */}
          <button
            type="button"
            onClick={prev}
            disabled={currentIndex === 0}
            className="p-1.5 rounded-lg transition-colors disabled:opacity-20 hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>

          {/* Dots + label */}
          <div className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
            {itemTitle && (
              <span className="text-xs text-muted-foreground/80 font-medium truncate max-w-full">
                {itemTitle}
              </span>
            )}
            <div className="flex items-center gap-1.5">
              {items.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => goTo(i)}
                  className={cn(
                    'rounded-full transition-colors',
                    i === currentIndex
                      ? 'w-5 h-1.5 bg-foreground/60'
                      : 'w-1.5 h-1.5 bg-foreground/15 hover:bg-foreground/30',
                  )}
                />
              ))}
            </div>
          </div>

          {/* Next */}
          <button
            type="button"
            onClick={next}
            disabled={currentIndex === count - 1}
            className="p-1.5 rounded-lg transition-colors disabled:opacity-20 hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
