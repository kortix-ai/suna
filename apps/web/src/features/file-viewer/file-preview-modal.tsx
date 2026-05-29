'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X, Download, ChevronLeft, ChevronRight, History, Code, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDialogDepth, dialogOverlayZ, dialogContentZ } from '@/lib/z-stack';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { FileContentRenderer, getLanguageFromExt } from './file-content-renderer';
import { FileSourceProvider, type FileSource } from './file-source';

/** Tabbable elements used by the focus trap below. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The slice of a feature's files store the preview modal reads. */
export interface FilePreviewState {
  selectedFilePath: string | null;
  panelMode: 'welcome' | 'viewer' | 'history';
  filePathList: string[];
  currentFileIndex: number;
}

export interface FilePreviewModalProps extends FilePreviewState {
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  /** Data access for the file body + the toolbar download button. */
  source: FileSource;
  /** Feature-specific history popover (worded "commits" vs "checkpoints"). */
  HistoryContent: ComponentType<{ filePath: string; onClose: () => void }>;
  /** Renders the file-type icon (kept as a prop so this module stays decoupled). */
  renderFileIcon: (fileName: string) => ReactNode;
  /** Optional chip shown next to the filename (e.g. git status). */
  statusSlot?: ReactNode;
  /** Optional extra toolbar actions, shown before Download (e.g. open-in-tab). */
  extraActions?: ReactNode;
  /** History button tooltip. */
  historyLabel?: string;
}

/**
 * The single full-screen file preview modal shared by every surface (the
 * session Files tab and the Customize Files section). Feature wrappers
 * subscribe to their own files store and pass the state/actions + a data
 * source down; this component owns all the chrome so every surface looks and
 * behaves identically (one full-bleed brand style, no variants).
 *
 * It portals to <body>. Two things make it survive being nested inside a
 * parent Radix modal Dialog (the Customize overlay), which would otherwise
 * make it inert:
 *  1. `pointer-events-auto` on the backdrop + surface — Radix sets body
 *     `pointer-events:none` on everything outside its own content, so without
 *     this every click is dead.
 *  2. A native `wheel`/`touchmove` listener that stops propagation before the
 *     event reaches `document`, where Radix's `react-remove-scroll` would call
 *     `preventDefault` and kill mouse-wheel scrolling. (Keyboard scroll never
 *     hit that path, which is why only the mouse appeared broken.)
 * Z-index is dialog-depth aware so it always stacks above its host overlay.
 */
export function FilePreviewModal({
  selectedFilePath,
  panelMode,
  filePathList,
  currentFileIndex,
  onClose,
  onNext,
  onPrev,
  source,
  HistoryContent,
  renderFileIcon,
  statusSlot,
  extraActions,
  historyLabel = 'History',
}: FilePreviewModalProps) {
  const dialogDepth = useDialogDepth();
  const isOpen = panelMode === 'viewer' && !!selectedFilePath;

  const fileName = selectedFilePath?.split('/').pop() || '';
  const hasNext = currentFileIndex < filePathList.length - 1;
  const hasPrev = currentFileIndex > 0;

  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const isMarkdownFile = getLanguageFromExt(fileName) === 'markdown';

  // The dialog surface — focus target for the trap and the focus-on-open below.
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Reset transient view state when the file changes.
  useEffect(() => {
    setHistoryPath(null);
    setMarkdownPreview(true);
  }, [selectedFilePath]);

  // Keyboard navigation. Capture-phase + stopImmediatePropagation so ESC only
  // closes the preview, not a host Radix dialog underneath (Customize overlay).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Focus trap: keep Tab cycling within the dialog. Only acts when focus is
      // already inside our surface, so when nested under the Customize Radix
      // dialog (whose own FocusScope owns focus) we don't hijack its Tab order.
      if (e.key === 'Tab') {
        const surface = surfaceRef.current;
        if (surface && surface.contains(document.activeElement)) {
          const focusables = Array.from(
            surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
          ).filter(
            (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0,
          );
          if (focusables.length === 0) {
            e.preventDefault();
            surface.focus();
          } else {
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey) {
              if (active === first || active === surface) {
                e.preventDefault();
                last.focus();
              }
            } else if (active === last || active === surface) {
              e.preventDefault();
              first.focus();
            }
          }
        }
        return;
      }
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (historyPath) setHistoryPath(null);
        else onClose();
        return;
      }
      if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        onNext();
        return;
      }
      if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        onPrev();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose, onNext, onPrev, hasNext, hasPrev, historyPath]);

  // Move focus into the dialog on open and restore it to the triggering element
  // on close. Standalone (session Files tab) this completes the focus trap;
  // nested under the Customize Radix dialog, Radix's FocusScope may keep focus —
  // we make a single, non-looping attempt and don't fight it (no regression).
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    surfaceRef.current?.focus();
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  // Lock body scroll while open.
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen]);

  // Keep wheel/touch scroll alive when nested under a Radix modal Dialog:
  // stop the event before it reaches document, where react-remove-scroll would
  // preventDefault it. Native listener (not React onWheel) so it fires during
  // real DOM bubbling, ahead of the document-level listener.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const el = contentRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener('wheel', stop, { passive: false });
    el.addEventListener('touchmove', stop, { passive: false });
    return () => {
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchmove', stop);
    };
  }, [isOpen, selectedFilePath]);

  const handleDownload = useCallback(async () => {
    if (!selectedFilePath) return;
    try {
      await source.download(selectedFilePath, fileName);
      toast.success(`Downloaded ${fileName}`);
    } catch {
      toast.error(`Failed to download ${fileName}`);
    }
  }, [selectedFilePath, fileName, source]);

  if (!isOpen) return null;
  // Portal to <body>: this fixed overlay is rendered inside constrained
  // containers (session side panel / Customize section) whose overflow-hidden
  // or display:none would clip or collapse it. React context is preserved.
  if (typeof document === 'undefined') return null;

  const toolbar = (
    <>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          title="Back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          {renderFileIcon(fileName)}
          <span className="text-sm font-medium truncate max-w-[300px]" title={selectedFilePath ?? ''}>
            {fileName}
          </span>
        </div>
        {statusSlot}
        {filePathList.length > 1 && (
          <span className="text-xs text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-full shrink-0 tabular-nums">
            {currentFileIndex + 1} / {filePathList.length}
          </span>
        )}
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        {isMarkdownFile && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              markdownPreview ? 'text-muted-foreground hover:text-foreground' : 'text-foreground bg-muted',
            )}
            onClick={() => setMarkdownPreview((v) => !v)}
            title={markdownPreview ? 'View source' : 'Preview'}
          >
            {markdownPreview ? <Code className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8',
            historyPath ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setHistoryPath(historyPath ? null : selectedFilePath)}
          title={historyLabel}
        >
          <History className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={handleDownload}
          title="Download"
        >
          <Download className="h-4 w-4" />
        </Button>
        {extraActions}
        <div className="w-px h-5 bg-border/50 mx-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </>
  );

  const body = (
    <>
      {hasPrev && (
        <button
          onClick={onPrev}
          className="absolute left-3 top-1/2 -translate-y-1/2 z-20 h-9 w-9 rounded-full bg-background/95 backdrop-blur border border-border/60 shadow-sm hover:bg-background flex items-center justify-center transition-all opacity-70 hover:opacity-100"
          title="Previous file"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {hasNext && (
        <button
          onClick={onNext}
          className="absolute right-3 top-1/2 -translate-y-1/2 z-20 h-9 w-9 rounded-full bg-background/95 backdrop-blur border border-border/60 shadow-sm hover:bg-background flex items-center justify-center transition-all opacity-70 hover:opacity-100"
          title="Next file"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      <div className="h-full w-full overflow-hidden">
        <FileSourceProvider value={source}>
          <FileContentRenderer
            filePath={selectedFilePath!}
            showHeader={false}
            readOnly
            markdownPreview={markdownPreview}
            onMarkdownPreviewChange={setMarkdownPreview}
          />
        </FileSourceProvider>
      </div>

      {historyPath && (
        <div className="absolute bottom-4 right-4 z-30 bg-popover border border-border/60 rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 fade-in-0 duration-150">
          <HistoryContent filePath={historyPath} onClose={() => setHistoryPath(null)} />
        </div>
      )}
    </>
  );

  const node = (
    <>
      <div
        data-file-preview-overlay=""
        className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in-0 duration-150 pointer-events-auto"
        style={{ zIndex: dialogOverlayZ(dialogDepth + 1) }}
        onClick={onClose}
      />
      <div
        ref={surfaceRef}
        data-file-preview-overlay=""
        role="dialog"
        aria-modal="true"
        aria-label={`File preview${fileName ? `: ${fileName}` : ''}`}
        tabIndex={-1}
        className="kx-fullscreen-modal fixed inset-3 sm:inset-4 flex flex-col rounded-2xl border border-border/60 bg-background shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-[0.98] duration-150 pointer-events-auto outline-none"
        style={{ zIndex: dialogContentZ(dialogDepth + 1) }}
      >
        <div className="flex items-center gap-2 px-3 h-12 border-b border-border/40 shrink-0 bg-background/95 backdrop-blur-sm">
          {toolbar}
        </div>
        <div ref={contentRef} className="flex-1 relative min-h-0 overflow-hidden">
          {body}
        </div>
      </div>
    </>
  );

  return createPortal(node, document.body);
}
