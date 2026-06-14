'use client';

import { Button } from '@/components/ui/button';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { dialogContentZ, dialogOverlayZ, useDialogDepth } from '@/lib/z-stack';
import {
  ChevronLeft,
  ChevronRight,
  Code,
  Download,
  Eye,
  History,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
  /**
   * When true, the viewer renders INLINE — filling its (relative) parent
   * container instead of portaling to a full-screen overlay. An "Expand"
   * button in the toolbar lets the user pop it to the full-screen view. Used
   * by the session side panel so files open in the panel, not over the page.
   */
  embedded?: boolean;
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
  embedded = false,
}: FilePreviewModalProps) {
  const dialogDepth = useDialogDepth();
  const isOpen = panelMode === 'viewer' && !!selectedFilePath;

  // Embedded viewers start inline (in the side panel); "Expand" pops them to
  // the full-screen overlay. Non-embedded viewers are always full-screen.
  const [expanded, setExpanded] = useState(false);
  const fullscreen = !embedded || expanded;

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
    setExpanded(false);
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
        else if (embedded && expanded) setExpanded(false);
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
  }, [isOpen, onClose, onNext, onPrev, hasNext, hasPrev, historyPath, embedded, expanded]);

  // Move focus into the dialog on open and restore it to the triggering element
  // on close. Standalone (session Files tab) this completes the focus trap;
  // nested under the Customize Radix dialog, Radix's FocusScope may keep focus —
  // we make a single, non-looping attempt and don't fight it (no regression).
  useEffect(() => {
    // Inline (embedded) viewers must not steal focus from the chat composer.
    if (!isOpen || !fullscreen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    surfaceRef.current?.focus();
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, fullscreen]);

  // Lock body scroll only while shown full-screen (inline viewers scroll within
  // the panel and must leave the rest of the page scrollable).
  useEffect(() => {
    if (isOpen && fullscreen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen, fullscreen]);

  // Keep wheel/touch scroll alive when nested under a Radix modal Dialog:
  // stop the event before it reaches document, where react-remove-scroll would
  // preventDefault it. Native listener (not React onWheel) so it fires during
  // real DOM bubbling, ahead of the document-level listener.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen || !fullscreen) return;
    const el = contentRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener('wheel', stop, { passive: false });
    el.addEventListener('touchmove', stop, { passive: false });
    return () => {
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchmove', stop);
    };
  }, [isOpen, fullscreen, selectedFilePath]);

  const handleDownload = useCallback(async () => {
    if (!selectedFilePath) return;
    try {
      await source.download(selectedFilePath, fileName);
      successToast(`Downloaded ${fileName}`);
    } catch {
      errorToast(`Failed to download ${fileName}`);
    }
  }, [selectedFilePath, fileName, source]);

  if (!isOpen) return null;
  // Portal to <body>: this fixed overlay is rendered inside constrained
  // containers (session side panel / Customize section) whose overflow-hidden
  // or display:none would clip or collapse it. React context is preserved.
  if (typeof document === 'undefined') return null;

  const toolbar = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground h-8 w-8 shrink-0"
          onClick={onClose}
          title="Back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          {renderFileIcon(fileName)}
          <span
            className="max-w-[300px] truncate text-sm font-medium"
            title={selectedFilePath ?? ''}
          >
            {fileName}
          </span>
        </div>
        {statusSlot}
        {filePathList.length > 1 && (
          <span className="text-muted-foreground bg-muted/60 shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums">
            {currentFileIndex + 1} / {filePathList.length}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {isMarkdownFile && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              markdownPreview
                ? 'text-muted-foreground hover:text-foreground'
                : 'text-foreground bg-muted',
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
            historyPath
              ? 'text-foreground bg-muted'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setHistoryPath(historyPath ? null : selectedFilePath)}
          title={historyLabel}
        >
          <History className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground h-8 w-8"
          onClick={handleDownload}
          title="Download"
        >
          <Download className="h-4 w-4" />
        </Button>
        {extraActions}
        {embedded && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-8 w-8"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Collapse to panel' : 'Expand'}
          >
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        )}
        <div className="bg-border/50 mx-1 h-5 w-px" />
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground h-8 w-8"
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
          className="bg-background/95 border-border/60 hover:bg-background absolute top-1/2 left-3 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border opacity-70 shadow-sm backdrop-blur transition-all hover:opacity-100"
          title="Previous file"
          aria-label="Previous file"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {hasNext && (
        <button
          onClick={onNext}
          className="bg-background/95 border-border/60 hover:bg-background absolute top-1/2 right-3 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border opacity-70 shadow-sm backdrop-blur transition-all hover:opacity-100"
          title="Next file"
          aria-label="Next file"
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
        <div className="bg-popover border-border/60 animate-in slide-in-from-bottom-4 fade-in-0 absolute right-4 bottom-4 z-30 overflow-hidden rounded-2xl border shadow-2xl duration-150">
          <HistoryContent filePath={historyPath} onClose={() => setHistoryPath(null)} />
        </div>
      )}
    </>
  );

  const panelInner = (
    <>
      <div className="border-border/40 bg-background/95 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur-sm">
        {toolbar}
      </div>
      <div ref={contentRef} className="relative min-h-0 flex-1 overflow-hidden">
        {body}
      </div>
    </>
  );

  // Inline (embedded, not expanded): fill the relative parent — the side panel —
  // instead of portaling to a full-screen overlay. No backdrop, no body lock.
  if (!fullscreen) {
    return (
      <div
        ref={surfaceRef}
        data-file-preview-embedded=""
        role="dialog"
        aria-label={`File preview${fileName ? `: ${fileName}` : ''}`}
        tabIndex={-1}
        className="bg-background animate-in fade-in-0 absolute inset-0 z-20 flex flex-col overflow-hidden duration-150 outline-none"
      >
        {panelInner}
      </div>
    );
  }

  const node = (
    <>
      <div
        data-file-preview-overlay=""
        className="animate-in fade-in-0 pointer-events-auto fixed inset-0 bg-black/50 backdrop-blur-sm duration-150"
        style={{ zIndex: dialogOverlayZ(dialogDepth + 1) }}
        onClick={embedded ? () => setExpanded(false) : onClose}
      />
      <div
        ref={surfaceRef}
        data-file-preview-overlay=""
        role="dialog"
        aria-modal="true"
        aria-label={`File preview${fileName ? `: ${fileName}` : ''}`}
        tabIndex={-1}
        className="kx-fullscreen-modal border-border/60 bg-background animate-in fade-in-0 zoom-in-[0.98] pointer-events-auto fixed inset-3 flex flex-col overflow-hidden rounded-2xl border shadow-2xl duration-150 outline-none sm:inset-4"
        style={{ zIndex: dialogContentZ(dialogDepth + 1) }}
      >
        {panelInner}
      </div>
    </>
  );

  return createPortal(node, document.body);
}
