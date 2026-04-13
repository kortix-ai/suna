'use client';

import { useMemo, useState, useEffect, useRef, Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { codeToHtml } from 'shiki';
import { cn } from '@/lib/utils';
import { useFileContent } from '../hooks';
import { getFileCategory, getLanguageFromExt } from './file-content-renderer';
import { getFileIcon } from './file-icon';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { SANDBOX_PORTS } from '@/lib/platform-client';
import { isHeicFile } from '@/lib/utils/heic-convert';
import { useBinaryBlob } from '../hooks/use-binary-blob';
import { useHeicBlob } from '@/hooks/use-heic-url';
import { getIframeSandbox } from '@/lib/security/iframe-sandbox';

/** Ensure a sandbox file path starts with /workspace/ for the static file server. */
function ensureWorkspacePath(filePath: string): string {
  if (filePath.startsWith('/workspace/')) return filePath;
  return '/workspace/' + filePath.replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// Image Thumbnail — loads base64 from API
// ---------------------------------------------------------------------------

function ImageThumbnail({ filePath }: { filePath: string }) {
  const fileName = filePath.split('/').pop() || '';
  const isHeic = isHeicFile(fileName);
  const [imgError, setImgError] = useState(false);

  // Non-HEIC: text/base64 API. HEIC: raw blob API + conversion.
  const { data: fileContent } = useFileContent(filePath, { staleTime: 60_000, enabled: !isHeic });
  const { blob: rawBlob } = useBinaryBlob(isHeic ? filePath : null);
  const { url: heicUrl } = useHeicBlob(isHeic ? rawBlob : null, fileName);

  const src = useMemo(() => {
    if (isHeic) return heicUrl;
    if (fileContent?.encoding === 'base64' && fileContent.mimeType?.startsWith('image/'))
      return `data:${fileContent.mimeType};base64,${fileContent.content}`;
    return null;
  }, [fileContent, isHeic, heicUrl]);

  if (!src || imgError) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" onError={() => setImgError(true)} draggable={false} />
  );
}

// ---------------------------------------------------------------------------
// Code / Text Thumbnail — shows first ~12 lines with syntax highlighting
// ---------------------------------------------------------------------------

/** Dark-mode CSS variable classes for shiki dual-theme output */
const shikiDarkModeClasses = cn(
  '[&_.shiki]:!bg-transparent',
  '[&_pre]:!bg-transparent',
  '[&_pre]:!p-0',
  '[&_pre]:!m-0',
  '[&_code]:!p-0',
  '[&_code]:!m-0',
  'dark:[&_.shiki_span]:!text-[var(--shiki-dark)]',
  'dark:[&_.shiki_span]:![font-style:var(--shiki-dark-font-style)]',
  'dark:[&_.shiki_span]:![font-weight:var(--shiki-dark-font-weight)]',
);

function CodeThumbnail({ filePath, fileName }: { filePath: string; fileName: string }) {
  const { data: fileContent } = useFileContent(filePath, { staleTime: 60_000 });
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!fileContent?.content || fileContent.type === 'binary') return null;
    return fileContent.content.split('\n').slice(0, 12).join('\n');
  }, [fileContent]);

  const language = useMemo(() => {
    return getLanguageFromExt(fileName);
  }, [fileName]);

  useEffect(() => {
    if (!preview) return;
    let cancelled = false;

    const lang = language === 'plaintext' ? 'text' : language;

    codeToHtml(preview, {
      lang,
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    }).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    }).catch(() => {
      // Fallback: keep null, render plain text
    });

    return () => { cancelled = true; };
  }, [preview, language]);

  if (!preview) return null;

  return (
    <div className="absolute inset-0 p-2 overflow-hidden">
      {highlightedHtml ? (
        <div
          className={cn(
            'text-[7px] leading-[1.4] font-mono whitespace-pre overflow-hidden select-none pointer-events-none',
            '[&_code]:!text-[7px] [&_code]:!leading-[1.4]',
            shikiDarkModeClasses,
          )}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="text-[7px] leading-[1.4] text-muted-foreground/70 font-mono whitespace-pre overflow-hidden select-none pointer-events-none">
          {preview}
        </pre>
      )}
      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted/20 to-transparent" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown Thumbnail — shows rendered preview snippet
// ---------------------------------------------------------------------------

function MarkdownThumbnail({ filePath }: { filePath: string }) {
  const { data: fileContent } = useFileContent(filePath, { staleTime: 60_000 });

  const preview = useMemo(() => {
    if (!fileContent?.content) return null;
    // Show first ~150 chars of markdown, strip headers/links for brief display
    const text = fileContent.content
      .replace(/^#{1,6}\s+/gm, '') // strip heading markers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) -> text
      .replace(/[*_`~]/g, '') // strip formatting markers
      .trim();
    return text.slice(0, 200);
  }, [fileContent]);

  if (!preview) return null;

  return (
    <div className="absolute inset-0 p-2.5 overflow-hidden">
      <p className="text-[8px] leading-[1.5] text-muted-foreground/60 select-none pointer-events-none line-clamp-[8]">
        {preview}
      </p>
      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted/20 to-transparent" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV / Spreadsheet Thumbnail — shows a mini table
// ---------------------------------------------------------------------------

function CsvThumbnail({ filePath }: { filePath: string }) {
  const { data: fileContent } = useFileContent(filePath, { staleTime: 60_000 });

  const rows = useMemo(() => {
    if (!fileContent?.content) return null;
    const lines = fileContent.content.split('\n').filter(Boolean).slice(0, 6);
    return lines.map((line) => {
      const sep = line.includes('\t') ? '\t' : ',';
      return line.split(sep).slice(0, 5).map((cell) => cell.replace(/^"(.*)"$/, '$1').trim());
    });
  }, [fileContent]);

  if (!rows || rows.length === 0) return null;

  return (
    <div className="absolute inset-0 p-2 overflow-hidden">
      <table className="w-full text-[7px] text-muted-foreground/60 select-none pointer-events-none border-collapse">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i === 0 ? 'font-medium text-muted-foreground/80' : ''}>
              {row.map((cell, j) => (
                <td key={j} className="px-0.5 py-px truncate max-w-[60px] border-b border-border/20">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-muted/20 to-transparent" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON Thumbnail — shows formatted JSON preview with syntax highlighting
// ---------------------------------------------------------------------------

function JsonThumbnail({ filePath, fileName }: { filePath: string; fileName: string }) {
  const { data: fileContent } = useFileContent(filePath, { staleTime: 60_000 });
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!fileContent?.content) return null;
    try {
      const parsed = JSON.parse(fileContent.content);
      return JSON.stringify(parsed, null, 2).split('\n').slice(0, 12).join('\n');
    } catch {
      return fileContent.content.split('\n').slice(0, 12).join('\n');
    }
  }, [fileContent]);

  useEffect(() => {
    if (!preview) return;
    let cancelled = false;

    codeToHtml(preview, {
      lang: 'json',
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    }).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    }).catch(() => {
      // Fallback: keep null, render plain text
    });

    return () => { cancelled = true; };
  }, [preview]);

  if (!preview) return null;

  return (
    <div className="absolute inset-0 p-2 overflow-hidden">
      {highlightedHtml ? (
        <div
          className={cn(
            'text-[7px] leading-[1.4] font-mono whitespace-pre overflow-hidden select-none pointer-events-none',
            '[&_code]:!text-[7px] [&_code]:!leading-[1.4]',
            shikiDarkModeClasses,
          )}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="text-[7px] leading-[1.4] text-muted-foreground/70 font-mono whitespace-pre overflow-hidden select-none pointer-events-none">
          {preview}
        </pre>
      )}
      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted/20 to-transparent" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// HTML Thumbnail — scaled iframe preview via static file server (port 3211)
// ---------------------------------------------------------------------------

function HtmlThumbnail({ filePath }: { filePath: string }) {
  const { rewritePortPath } = useSandboxProxy();
  const staticPort = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);

  // Proxy URL for the file itself
  const previewUrl = useMemo(() => {
    const normalizedPath = ensureWorkspacePath(filePath);
    const encodedPath = normalizedPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return rewritePortPath(staticPort, `/open?path=/${encodedPath}`);
  }, [filePath, rewritePortPath, staticPort]);

  // Health URL — poll until server is ready
  const healthUrl = useMemo(
    () => rewritePortPath(staticPort, '/health'),
    [rewritePortPath, staticPort],
  );

  const [ready, setReady] = useState(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!healthUrl) return;
    let cancelled = false;
    setReady(false);

    async function check() {
      try {
        const res = await fetch(healthUrl, { method: 'GET', credentials: 'include' });
        if (cancelled) return;
        if (res.ok) { setReady(true); return; }
      } catch { /* not ready yet */ }
      if (!cancelled) retryRef.current = setTimeout(check, 1500);
    }

    check();
    return () => {
      cancelled = true;
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [healthUrl]);

  // Container ref for scaling the iframe to fit
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0) {
        setScale(w / 1280);
        setContainerSize({ w, h });
      }
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  const iframeHeight = containerSize.w > 0 && containerSize.h > 0
    ? Math.round(1280 / (containerSize.w / containerSize.h))
    : 800;

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden select-none pointer-events-none">
      {!ready || scale === 0 ? (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/30" />
        </div>
      ) : (
        <iframe
          src={previewUrl}
          title=""
          className="border-0 origin-top-left"
          style={{
            width: `${1280}px`,
            height: `${iframeHeight}px`,
            transform: `scale(${scale})`,
          }}
          sandbox={getIframeSandbox({ isolateHtmlPreview: true })}
          tabIndex={-1}
        />
      )}
      {/* Fade overlay so the badge stays readable */}
      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted/30 to-transparent" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main FileThumbnail — picks the right thumbnail based on file type
// ---------------------------------------------------------------------------

interface FileThumbnailProps {
  filePath: string;
  fileName: string;
  className?: string;
}

/**
 * Renders a rich thumbnail preview for grid file cards.
 * 
 * Supported:
 * - Images: actual image preview
 * - Code/text: first lines of source code
 * - Markdown: rendered text snippet
 * - CSV/TSV: mini table
 * - JSON: formatted JSON preview
 * - Everything else: large icon fallback
 */
export function FileThumbnail({ filePath, fileName, className }: FileThumbnailProps) {
  const category = getFileCategory(fileName);
  const language = getLanguageFromExt(fileName);
  const isMarkdown = language === 'markdown';
  const isJson = language === 'json';
  const isCsv = category === 'csv';
  const isImage = category === 'image';
  const isHtml = category === 'html';
  const isCode = category === 'code' && !isJson;
  // Treat plaintext files (.txt, .rst, .rtf, .log, etc.) as text even when
  // getFileCategory returns 'binary' (it needs mimeType we don't have here)
  const extLower = fileName.split('.').pop()?.toLowerCase() || '';
  const nameLower = fileName.toLowerCase();
  const isPlaintext = ['txt', 'rst', 'rtf', 'log', 'text', 'nfo', 'cfg', 'ini', 'conf', 'properties'].includes(extLower)
    || ['.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', 'license', 'readme', 'changelog', 'makefile', 'dockerfile'].some(n => nameLower === n || nameLower.endsWith(n));
  const isText = category === 'text' || isMarkdown || isPlaintext;
  const ext = fileName.includes('.') ? extLower.toUpperCase() : '';

  // Determine which single thumbnail to render (mutually exclusive)
  let thumbnailType: 'image' | 'html' | 'csv' | 'json' | 'markdown' | 'code' | 'text' | 'fallback';
  if (isImage) thumbnailType = 'image';
  else if (isHtml) thumbnailType = 'html';
  else if (isCsv) thumbnailType = 'csv';
  else if (isJson) thumbnailType = 'json';
  else if (isMarkdown) thumbnailType = 'markdown';
  else if (isCode) thumbnailType = 'code';
  else if (isText) thumbnailType = 'text';
  else thumbnailType = 'fallback';

  return (
    <div className={cn('flex items-center justify-center relative overflow-hidden bg-muted/20', className)}>
      {/* Thumbnails by type — only one renders */}
      {thumbnailType === 'image' && <ImageThumbnail filePath={filePath} />}
      {thumbnailType === 'html' && <HtmlThumbnail filePath={filePath} />}
      {thumbnailType === 'code' && <CodeThumbnail filePath={filePath} fileName={fileName} />}
      {thumbnailType === 'markdown' && <MarkdownThumbnail filePath={filePath} />}
      {thumbnailType === 'json' && <JsonThumbnail filePath={filePath} fileName={fileName} />}
      {thumbnailType === 'csv' && <CsvThumbnail filePath={filePath} />}
      {thumbnailType === 'text' && <CodeThumbnail filePath={filePath} fileName={fileName} />}
      {thumbnailType === 'fallback' && getFileIcon(fileName, { className: 'h-12 w-12', variant: 'monochrome' })}

      {/* File type badge (shown for non-image types) */}
      {ext && thumbnailType !== 'image' && (
        <span className="absolute bottom-1.5 right-1.5 text-[0.5625rem] font-medium text-muted-foreground/50 uppercase tracking-wider bg-background/80 px-1.5 py-0.5 rounded z-10">
          {ext}
        </span>
      )}
    </div>
  );
}
