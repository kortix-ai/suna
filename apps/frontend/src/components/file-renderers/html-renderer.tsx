'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { CodeEditor } from '@/components/file-editors';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Monitor, Code, ExternalLink } from 'lucide-react';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { Badge } from '@/components/ui/badge';

interface FileRendererProject {
  id?: string;
  name?: string;
  description?: string;
  created_at?: string;
  sandbox?: {
    id?: string;
    sandbox_url?: string;
    vnc_preview?: string;
    pass?: string;
  };
}

interface HtmlRendererProps {
  content: string;
  previewUrl: string;
  className?: string;
  project?: FileRendererProject;
}

function getBaseHrefFromPreviewUrl(previewUrl: string): string | undefined {
  try {
    const url = new URL(previewUrl);
    url.hash = '';
    url.search = '';

    const lastSlash = url.pathname.lastIndexOf('/');
    url.pathname = lastSlash >= 0 ? url.pathname.slice(0, lastSlash + 1) : '/';
    return url.toString();
  } catch {
    return undefined;
  }
}

function injectBaseHrefIntoHtml(html: string, baseHref?: string): string {
  if (!baseHref) return html;
  if (/<base\b/i.test(html)) return html;

  const baseTag = `<base href="${baseHref}">`;

  // If there's a <head>, inject right after it.
  const headOpenMatch = html.match(/<head\b[^>]*>/i);
  if (headOpenMatch?.index !== undefined) {
    const insertAt = headOpenMatch.index + headOpenMatch[0].length;
    return `${html.slice(0, insertAt)}\n    ${baseTag}\n${html.slice(insertAt)}`;
  }

  // If there's an <html>, insert a <head> after it.
  const htmlOpenMatch = html.match(/<html\b[^>]*>/i);
  if (htmlOpenMatch?.index !== undefined) {
    const insertAt = htmlOpenMatch.index + htmlOpenMatch[0].length;
    const headBlock = `\n  <head>\n    <meta charset="utf-8" />\n    ${baseTag}\n  </head>\n`;
    return `${html.slice(0, insertAt)}${headBlock}${html.slice(insertAt)}`;
  }

  // Fallback: prepend a head block.
  return `<head><meta charset="utf-8" />${baseTag}</head>\n${html}`;
}

function appendCacheBust(url: string, attempt: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set('__kortix_preview_retry', String(attempt));
    u.searchParams.set('__kortix_preview_ts', String(Date.now()));
    return u.toString();
  } catch {
    const join = url.includes('?') ? '&' : '?';
    return `${url}${join}__kortix_preview_retry=${attempt}&__kortix_preview_ts=${Date.now()}`;
  }
}

function ResilientHtmlPreview({
  content,
  liveUrl,
  className,
}: {
  content: string;
  liveUrl: string;
  className?: string;
}) {
  const canUseLive = useMemo(() => /^https?:\/\//i.test(liveUrl), [liveUrl]);

  // Always render something immediately via srcDoc to avoid blank states.
  const srcDoc = useMemo(() => {
    const baseHref = canUseLive ? getBaseHrefFromPreviewUrl(liveUrl) : undefined;
    const safeHtml =
      content && content.trim().length > 0
        ? content
        : `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HTML Preview</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; color: #111827; }
      .card { max-width: 720px; margin: 0 auto; padding: 16px 18px; border: 1px solid rgba(0,0,0,0.1); border-radius: 12px; background: #fff; }
      .title { font-weight: 600; margin: 0 0 6px; }
      .muted { margin: 0; color: rgba(17,24,39,0.7); font-size: 14px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="card">
      <p class="title">No HTML content to preview yet</p>
      <p class="muted">The file was created, but no content is available in the preview payload.</p>
    </div>
  </body>
</html>`;
    return injectBaseHrefIntoHtml(safeHtml, baseHref);
  }, [content, liveUrl, canUseLive]);

  const MAX_ATTEMPTS = 5;
  const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];
  const MIN_LOAD_MS_TO_ACCEPT = 250;

  const [attempt, setAttempt] = useState(0);
  const [isLiveVisible, setIsLiveVisible] = useState(false);
  const [liveSrc, setLiveSrc] = useState(() => appendCacheBust(liveUrl, 0));
  const [loadStartMs, setLoadStartMs] = useState<number>(() => Date.now());
  const [liveIsLoading, setLiveIsLoading] = useState(true);
  const [liveHasError, setLiveHasError] = useState(false);
  const retryTimerRef = React.useRef<number | null>(null);

  // Reset whenever the live URL changes (new file).
  useEffect(() => {
    setAttempt(0);
    setIsLiveVisible(false);
    setLiveHasError(false);
    setLiveIsLoading(true);
  }, [liveUrl]);

  // Update live src when attempt changes.
  useEffect(() => {
    if (!canUseLive) return;
    setLoadStartMs(Date.now());
    setLiveIsLoading(true);
    setLiveHasError(false);
    setLiveSrc(appendCacheBust(liveUrl, attempt));
  }, [attempt, liveUrl, canUseLive]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  const scheduleRetry = (reason: 'fast-load' | 'error') => {
    if (isLiveVisible) return;
    if (attempt >= MAX_ATTEMPTS) return;
    if (!canUseLive || !liveUrl) return;
    if (retryTimerRef.current) return;

    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    console.debug('[ResilientHtmlPreview] scheduling retry', {
      liveUrl,
      attempt,
      nextAttempt: attempt + 1,
      reason,
      delayMs: delay,
      maxAttempts: MAX_ATTEMPTS,
    });

    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setAttempt((prev) => prev + 1);
    }, delay);
  };

  const handleLiveLoad = () => {
    const loadMs = Date.now() - loadStartMs;
    setLiveIsLoading(false);

    console.debug('[ResilientHtmlPreview] live iframe loaded', {
      liveUrl,
      attempt,
      loadMs,
      minAcceptMs: MIN_LOAD_MS_TO_ACCEPT,
    });

    // Heuristic: ultra-fast loads are usually a cached blank/404 placeholder right after file creation.
    // Keep showing the srcDoc version and retry a few times.
    if (loadMs < MIN_LOAD_MS_TO_ACCEPT && attempt < MAX_ATTEMPTS) {
      scheduleRetry('fast-load');
      return;
    }

    setIsLiveVisible(true);
  };

  const handleLiveError = () => {
    setLiveIsLoading(false);
    setLiveHasError(true);
    scheduleRetry('error');
  };

  const handleManualRetry = () => {
    console.debug('[ResilientHtmlPreview] manual retry', { liveUrl });
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setAttempt(0);
    setIsLiveVisible(false);
    setLiveHasError(false);
    setLiveIsLoading(true);
  };

  return (
    <div className={cn('relative w-full h-full', className)}>
      {/* Always-visible fallback (no blank state) */}
      <iframe
        title="HTML Preview (fallback)"
        className="absolute inset-0 w-full h-full border-0"
        // Important: keep srcDoc isolated from the app origin
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        style={{ background: 'white' }}
        srcDoc={srcDoc}
      />

      {/* Live preview layered on top once it looks good */}
      {canUseLive && liveUrl ? (
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-200',
            isLiveVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <iframe
            src={liveSrc}
            title="HTML Preview (live)"
            className="absolute inset-0 w-full h-full border-0"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
            onLoad={handleLiveLoad}
            onError={handleLiveError}
            style={{ background: 'white' }}
          />
        </div>
      ) : null}

      {/* Status pill */}
      {canUseLive ? (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-2">
          {!isLiveVisible ? (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur-sm">
              {liveHasError ? 'Live preview error' : liveIsLoading ? 'Live preview loading' : 'Live preview pending'}
              {attempt > 0 ? ` (retry ${attempt}/${MAX_ATTEMPTS})` : ''}
            </Badge>
          ) : (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur-sm">
              Live preview
            </Badge>
          )}

          {!isLiveVisible && attempt >= MAX_ATTEMPTS ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 bg-background/80 backdrop-blur-sm hover:bg-background/90"
              onClick={handleManualRetry}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function HtmlRenderer({
  content,
  previewUrl,
  className,
  project,
}: HtmlRendererProps) {
  // Always default to 'preview' mode
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

  // Check if previewUrl is already a valid sandbox preview URL (not an API endpoint)
  const isAlreadySandboxUrl = useMemo(() => {
    if (!previewUrl) return false;
    const isFullUrl = previewUrl.includes('://');
    const isApiEndpoint = previewUrl.includes('/sandboxes/') || previewUrl.includes('/files/content');
    return isFullUrl && !isApiEndpoint;
  }, [previewUrl]);

  // Create a blob URL for HTML content if no sandbox is available (fallback)
  const blobHtmlUrl = useMemo(() => {
    if (content && !project?.sandbox?.sandbox_url && !isAlreadySandboxUrl) {
      const blob = new Blob([content], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }
    return undefined;
  }, [content, project?.sandbox?.sandbox_url, isAlreadySandboxUrl]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobHtmlUrl) {
        URL.revokeObjectURL(blobHtmlUrl);
      }
    };
  }, [blobHtmlUrl]);

  // Extract file path from previewUrl if it's a full API URL
  const filePath = useMemo(() => {
    // If previewUrl is already a sandbox URL, no need to extract path
    if (isAlreadySandboxUrl) {
      return '';
    }

    try {
      // If it's an API URL (check for various patterns: /api/sandboxes/, /sandboxes/, /v1/sandboxes/)
      if (previewUrl.includes('/sandboxes/') && previewUrl.includes('/files/content')) {
        // Try to extract path parameter from query string
        const pathMatch = previewUrl.match(/[?&]path=([^&]+)/);
        if (pathMatch) {
          const decodedPath = decodeURIComponent(pathMatch[1]);
          // Remove /workspace/ prefix if present
          const cleanPath = decodedPath.replace(/^\/workspace\//, '');
          if (cleanPath) {
            return cleanPath;
          }
        }
        
        // Fallback: try parsing as URL if it's a full URL
        if (previewUrl.includes('://')) {
          const url = new URL(previewUrl);
          const path = url.searchParams.get('path');
          if (path) {
            const decodedPath = decodeURIComponent(path);
            const cleanPath = decodedPath.replace(/^\/workspace\//, '');
            if (cleanPath) {
              return cleanPath;
            }
          }
        }
      }

      // If previewUrl is already a simple file path (not a full URL), use it directly
      if (!previewUrl.includes('://') && !previewUrl.includes('/sandboxes/')) {
        // Remove /workspace/ prefix if present
        const cleanPath = previewUrl.replace(/^\/workspace\//, '');
        if (cleanPath) {
          return cleanPath;
        }
      }

      // If we can't extract a path, return empty string
      return '';
    } catch (e) {
      console.error('Error extracting file path from previewUrl:', e, { previewUrl });
      return '';
    }
  }, [previewUrl, isAlreadySandboxUrl]);

  // Construct HTML file preview URL using the sandbox URL and file path
  const htmlPreviewUrl = useMemo(() => {
    // If previewUrl is already a valid sandbox URL, use it directly
    if (isAlreadySandboxUrl) {
      return previewUrl;
    }

    // Construct preview URL if we have both sandbox URL and a valid file path
    if (project?.sandbox?.sandbox_url && filePath && !filePath.includes('://') && !filePath.includes('/sandboxes/')) {
      const constructedUrl = constructHtmlPreviewUrl(project.sandbox.sandbox_url, filePath);
      return constructedUrl;
    }

    // Fall back to blob URL if available
    if (blobHtmlUrl) {
      return blobHtmlUrl;
    }

    // If previewUrl looks like a valid URL (not an API endpoint), use it directly
    if (previewUrl && !previewUrl.includes('/sandboxes/') && !previewUrl.includes('/files/content')) {
      return previewUrl;
    }

    // No valid preview URL available
    return '';
  }, [project?.sandbox?.sandbox_url, filePath, previewUrl, isAlreadySandboxUrl, blobHtmlUrl]);

  return (
    <div className={cn('w-full h-full flex flex-col', className)}>
      {/* Content area */}
      <div className="flex-1 min-h-0 relative">
        {/* View mode toggle */}
        <div className="absolute left-2 top-2 z-10 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'flex items-center gap-2 bg-background/80 backdrop-blur-sm hover:bg-background/90',
              viewMode === 'preview' && 'bg-background/90',
            )}
            onClick={() => setViewMode('preview')}
          >
            <Monitor className="h-4 w-4" />
            Preview
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'flex items-center gap-2 bg-background/80 backdrop-blur-sm hover:bg-background/90',
              viewMode === 'code' && 'bg-background/90',
            )}
            onClick={() => setViewMode('code')}
          >
            <Code className="h-4 w-4" />
            Code
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex items-center gap-2 bg-background/80 backdrop-blur-sm hover:bg-background/90"
            onClick={() => window.open(htmlPreviewUrl || previewUrl, '_blank')}
            disabled={!htmlPreviewUrl && !previewUrl}
          >
            <ExternalLink className="h-4 w-4" />
            Open
          </Button>
        </div>

        {viewMode === 'preview' ? (
          <div className="absolute inset-0">
            {htmlPreviewUrl ? (
              <ResilientHtmlPreview
                content={content}
                liveUrl={htmlPreviewUrl}
                className="w-full h-full"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                Unable to load HTML preview
              </div>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 overflow-auto">
            <CodeEditor
              content={content}
              fileName="preview.html"
              readOnly={true}
              className="w-full min-h-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}
