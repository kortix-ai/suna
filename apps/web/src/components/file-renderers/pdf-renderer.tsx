'use client';

import { useTranslations } from 'next-intl';

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';

// Worker is copied to /public during postinstall (from pdfjs-dist@4.8.69).
const PDF_WORKER_SRC = '/pdf.worker.min.mjs';

// ── Zoom model ──────────────────────────────────────────────────────────────
// We compute the fit scale ourselves (availableWidth / pageNativeWidth) and
// render the page to a canvas at that scale × zoom. There is no library
// indirection that could render at native size, so a high-res PDF can never
// open hyper-zoomed — fit-to-width is the default and is exact.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.25;
const PAD_X = 40; // padding + scrollbar slack subtracted before fitting
const MAX_DPR = 2; // cap canvas pixel density so big pages don't blow up memory

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

interface PdfRendererProps {
  /** URL to load the PDF from (blob URL or http URL) */
  url?: string;
  /** Raw PDF blob — preferred over url */
  blob?: Blob | null;
  className?: string;
  /** Compact mode for inline previews — first page only, no controls */
  compact?: boolean;
}

export function PdfRenderer({ url, blob, className, compact = false }: PdfRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const measureRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [scalePct, setScalePct] = useState(100);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pageReady, setPageReady] = useState(false);

  // ── Load the document ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setPageReady(false);
    setNumPages(0);
    setPageNumber(1);

    (async () => {
      try {
        let data: Uint8Array | null = null;
        if (blob) {
          data = new Uint8Array(await blob.arrayBuffer());
        } else if (url) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = new Uint8Array(await res.arrayBuffer());
        }
        if (!data || data.byteLength === 0) throw new Error('Empty PDF');
        if (cancelled) return;

        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        const doc = await pdfjs.getDocument({ data }).promise;
        if (cancelled) {
          doc.destroy().catch(() => {});
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          console.error('[PdfRenderer] load failed:', err);
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch { /* noop */ }
        renderTaskRef.current = null;
      }
      const doc = docRef.current;
      docRef.current = null;
      if (doc) doc.destroy().catch(() => {});
    };
  }, [blob, url]);

  // ── Measure the available width (clientWidth, with a retry until laid out) ──
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    let raf = 0;
    let tries = 0;
    const apply = (): boolean => {
      const w = Math.floor(el.clientWidth || el.offsetWidth);
      if (w > 0) {
        setContainerWidth((prev) => (prev === w ? prev : w));
        return true;
      }
      return false;
    };
    const pump = () => {
      if (apply() || tries++ > 120) return;
      raf = requestAnimationFrame(pump);
    };
    pump();
    const observer = new ResizeObserver(() => apply());
    observer.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [status]);

  // ── Render the current page to the canvas ──────────────────────────────────
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || !numPages) return;

    // Fall back to a sane width if measurement hasn't landed yet, so we never
    // hang on a blank canvas.
    const available = containerWidth > 0
      ? containerWidth - PAD_X
      : Math.max(320, Math.min(820, (typeof window !== 'undefined' ? window.innerWidth : 800) - 80));

    let cancelled = false;
    (async () => {
      try {
        const page: PDFPageProxy = await doc.getPage(pageNumber);
        if (cancelled) return;

        const native = page.getViewport({ scale: 1 });
        const fitScale = Math.max(available, 64) / native.width;
        const scale = fitScale * zoom;
        const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, MAX_DPR);
        const viewport = page.getViewport({ scale: scale * dpr });

        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch { /* noop */ }
          renderTaskRef.current = null;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) return;
        renderTaskRef.current = null;
        setScalePct(Math.round(scale * 100));
        setPageReady(true);
      } catch (err) {
        // Cancelled renders are expected when page/zoom/size changes quickly.
        if ((err as { name?: string })?.name !== 'RenderingCancelledException' && !cancelled) {
          console.error('[PdfRenderer] render failed:', err);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [numPages, pageNumber, containerWidth, zoom]);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const goToPage = useCallback((page: number) => {
    if (page >= 1 && page <= (numPages || 1)) {
      setPageReady(false);
      setPageNumber(page);
      measureRef.current?.scrollTo({ top: 0, left: 0 });
    }
  }, [numPages]);

  const previousPage = useCallback(() => goToPage(pageNumber - 1), [pageNumber, goToPage]);
  const nextPage = useCallback(() => goToPage(pageNumber + 1), [pageNumber, goToPage]);

  // ── Zoom ───────────────────────────────────────────────────────────────────
  const canZoomIn = zoom < ZOOM_MAX - 1e-3;
  const canZoomOut = zoom > ZOOM_MIN + 1e-3;
  const isFit = Math.abs(zoom - 1) < 1e-3;
  const zoomIn = useCallback(() => setZoom((z) => clampZoom(z * ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => clampZoom(z / ZOOM_STEP)), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  // Keyboard navigation
  useEffect(() => {
    if (compact) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); previousPage(); break;
        case 'ArrowRight': e.preventDefault(); nextPage(); break;
        case '=':
        case '+': if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomIn(); } break;
        case '-': if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomOut(); } break;
        case '0': if (e.metaKey || e.ctrlKey) { e.preventDefault(); resetZoom(); } break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [compact, previousPage, nextPage, zoomIn, zoomOut, resetZoom]);

  // ── Compact mode: first page only, fit-to-width, no controls ───────────────
  if (compact) {
    return (
      <div
        ref={measureRef}
        className={cn('w-full h-full overflow-auto bg-muted/10 flex items-center justify-center p-2', className)}
      >
        {status === 'error' ? (
          <div className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line242JsxTextFailedToLoadPdf')}</div>
        ) : (
          <div className="relative">
            {!pageReady && (
              <div className="absolute inset-0 flex items-center justify-center">
                <KortixLoader size="medium" />
              </div>
            )}
            <canvas ref={canvasRef} className={cn('shadow-sm rounded-lg max-w-full', !pageReady && 'opacity-0')} />
          </div>
        )}
      </div>
    );
  }

  // ── Full mode ──────────────────────────────────────────────────────────────
  return (
    <div className={cn('flex flex-col w-full h-full bg-muted/20 overflow-hidden', className)}>
      <div ref={measureRef} className="flex-1 overflow-auto min-h-0">
        {status === 'error' ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line277JsxTextFailedToLoadPdf')}</p>
              <p className="text-xs text-muted-foreground mt-1">{tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line278JsxTextTheFileMayBeCorruptedOrInaccessible')}</p>
            </div>
          </div>
        ) : (
          // min-w-full centers the page when it fits; w-fit lets the scroll
          // container reach both edges when zoomed wider than the viewport.
          <div className="min-h-full min-w-full w-fit mx-auto flex items-start justify-center p-5">
            <div className="relative">
              {(status === 'loading' || !pageReady) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 min-h-64 min-w-48">
                  <KortixLoader size="medium" />
                  <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line290JsxTextLoadingPdf')}</p>
                </div>
              )}
              <canvas
                ref={canvasRef}
                className={cn('shadow-lg rounded-lg bg-white', !pageReady && 'opacity-0')}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom toolbar: zoom + page navigation */}
      {status === 'ready' && numPages > 0 && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-background border-t flex-shrink-0">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={zoomOut}
              disabled={!canZoomOut}
              className="h-7 w-7 p-0"
              title={tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line323JsxAttrTitleZoomOutCmd')}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>

            <button
              type="button"
              onClick={resetZoom}
              disabled={isFit}
              className={cn(
                'h-7 min-w-[3rem] px-1.5 rounded text-xs tabular-nums font-medium transition-colors',
                isFit
                  ? 'text-muted-foreground/50 cursor-default'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer',
              )}
              title={tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line338JsxAttrTitleResetZoomCmd0')}
            >
              {scalePct}%
            </button>

            <Button
              variant="ghost"
              size="sm"
              onClick={zoomIn}
              disabled={!canZoomIn}
              className="h-7 w-7 p-0"
              title={tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line349JsxAttrTitleZoomInCmd')}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>

          {numPages > 1 ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={previousPage}
                disabled={pageNumber <= 1}
                className="h-7 w-7 p-0"
                title={tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line364JsxAttrTitlePreviousPage')}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <div className="flex items-center gap-1 px-2">
                <span className="text-xs font-medium tabular-nums">{pageNumber}</span>
                <span className="text-xs text-muted-foreground">/</span>
                <span className="text-xs text-muted-foreground tabular-nums">{numPages}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={nextPage}
                disabled={pageNumber >= numPages}
                className="h-7 w-7 p-0"
                title={tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line385JsxAttrTitleNextPage')}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div />
          )}
        </div>
      )}
    </div>
  );
}
