"use client";

import { Button } from "../../primitives/button";
import { ButtonGroup } from "../../primitives/button-group";
import Hint from "../../primitives/hint";
import { errorToast, successToast } from "../../primitives/toast";
import { Download } from "../../internal/icons/download";
import { useTranslations } from "../../i18n";
import { cn } from "../../lib/utils";
import {
  dialogContentZ,
  DialogDepthProvider,
  dialogOverlayZ,
  useDialogLayerDepth,
} from "../../lib/z-stack";
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  CodeIcon as Code,
  EyeIcon as Eye,
  ClockCounterClockwiseIcon as History,
  ArrowsOutSimpleIcon as Maximize2,
  ArrowsInSimpleIcon as Minimize2,
  XIcon as X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FileContentRenderer } from "./file-content-renderer";
import {
  FileSourceProvider,
  type FileRefreshResult,
  type FileSource,
} from "./file-source";
import { getLanguageFromExt } from "./preview-policy";
import { SaveAsPdfButton } from "./save-as-pdf-button";
import {
  RefreshButton,
  ViewerActions,
  ViewerPathPill,
  fileShareInput,
} from "./viewer-actions";

/** Tabbable elements used by the focus trap below. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** The slice of a feature's files store the preview modal reads. */
export interface FilePreviewState {
  selectedFilePath: string | null;
  panelMode: "welcome" | "viewer" | "history";
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
  /** Public share context. Omit for non-session file surfaces. */
  shareContext?: { projectId: string; sessionId: string };
  /** History button tooltip. */
  historyLabel?: string;
  /** 1-based line to scroll to, e.g. a content-search match. Opens Markdown as source. */
  targetLine?: number | null;
  /**
   * When true, the viewer renders INLINE — filling its (relative) parent
   * container instead of portaling to a full-screen overlay. An "Expand"
   * button in the toolbar lets the user pop it to the full-screen view. Used
   * by the session side panel so files open in the panel, not over the page.
   */
  embedded?: boolean;
}

/** A fixed source (a git ref) has nothing to re-read. */
function useNoRefresh(_filePath: string | null): FileRefreshResult {
  return NO_REFRESH;
}
const NO_REFRESH: FileRefreshResult = {
  refresh: () => {},
  refreshing: false,
  reloadKey: 0,
};

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
  onClose: closePreview,
  onNext: nextPreview,
  onPrev: prevPreview,
  source,
  HistoryContent,
  renderFileIcon,
  statusSlot,
  extraActions,
  shareContext,
  historyLabel = "History",
  embedded = false,
  targetLine = null,
}: FilePreviewModalProps) {
  const tI18nHardcoded = useTranslations("hardcodedUi");
  const isOpen = panelMode === "viewer" && !!selectedFilePath;
  const [dirty, setDirty] = useState(false);
  const leave = (action: () => void) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setDirty(false);
    action();
  };
  const onClose = () => leave(closePreview);
  const onNext = () => leave(nextPreview);
  const onPrev = () => leave(prevPreview);

  // Embedded viewers start inline (in the side panel); "Expand" pops them to
  // the full-screen overlay. Non-embedded viewers are always full-screen.
  const [expanded, setExpanded] = useState(false);
  const fullscreen = !embedded || expanded;
  // Only the full-screen overlay is a layer; the inline panel sits in flow.
  const dialogDepth = useDialogLayerDepth(isOpen && fullscreen);

  const fileName = selectedFilePath?.split("/").pop() || "";
  const hasNext = currentFileIndex < filePathList.length - 1;
  const hasPrev = currentFileIndex > 0;

  const [historyPath, setHistoryPath] = useState<string | null>(null);
  // Module-stable per source, so the hook identity never changes between
  // renders — the same pattern `FileContentRenderer` uses for `useFileContent`.
  const useRefresh = source.useRefresh ?? useNoRefresh;
  const { refresh, refreshing, reloadKey } = useRefresh(selectedFilePath);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  // Markdown and Mermaid files both open rendered, with a Source toggle.
  const isMarkdownFile = ["markdown", "mermaid"].includes(
    getLanguageFromExt(fileName),
  );
  // Markdown alone also exports to PDF. Only its text is read here — the query
  // `FileContentRenderer` already runs for the same path, so no second fetch.
  // The PDF export renders through a session's sandbox; a bytes-only source has none.
  const exportsPdf =
    getLanguageFromExt(fileName) === "markdown" && !source.bytesOnly;
  const { data: pdfSource } = source.useFileContent(
    exportsPdf ? selectedFilePath : null,
  );


  // The dialog surface — focus target for the trap and the focus-on-open below.
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Reset transient view state when the file changes. A jump to a line shows
  // the source: rendered Markdown has no lines to scroll to.
  useEffect(() => {
    setHistoryPath(null);
    setMarkdownPreview(!targetLine);
    setExpanded(false);
  }, [selectedFilePath, targetLine]);

  // Keyboard navigation. Capture-phase + stopImmediatePropagation so ESC only
  // closes the preview, not a host Radix dialog underneath (Customize overlay).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Focus trap: keep Tab cycling within the dialog. Only acts when focus is
      // already inside our surface, so when nested under the Customize Radix
      // dialog (whose own FocusScope owns focus) we don't hijack its Tab order.
      if (e.key === "Tab") {
        const surface = surfaceRef.current;
        if (surface && surface.contains(document.activeElement)) {
          const focusables = Array.from(
            surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
          ).filter(
            (el) =>
              el.offsetWidth > 0 ||
              el.offsetHeight > 0 ||
              el.getClientRects().length > 0,
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
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (historyPath) setHistoryPath(null);
        else if (embedded && expanded) setExpanded(false);
        else onClose();
        return;
      }
      if (e.key === "ArrowRight" && hasNext) {
        e.preventDefault();
        onNext();
        return;
      }
      if (e.key === "ArrowLeft" && hasPrev) {
        e.preventDefault();
        onPrev();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    isOpen,
    onClose,
    onNext,
    onPrev,
    hasNext,
    hasPrev,
    historyPath,
    embedded,
    expanded,
  ]);

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
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, fullscreen]);

  // Lock body scroll only while shown full-screen (inline viewers scroll within
  // the panel and must leave the rest of the page scrollable).
  useEffect(() => {
    if (isOpen && fullscreen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, fullscreen]);

  // Keep wheel/touch scroll alive when nested under a Radix modal Dialog:
  // stop the event before it reaches document, where react-remove-scroll would
  // preventDefault it. Native listener (not React onWheel) so it fires during
  // real DOM bubbling, ahead of the document-level listener.
  const contentRef = useRef<HTMLDivElement | null>(null);
  // A host theme with larger controls, or a narrow panel: the toolbar drops the
  // Download label, the previous/next pair (the arrow keys still step), the
  // git status chip (the Changes tab carries it), Save as PDF and Copy link
  // (Expand brings all of them back), so the name stays readable and Expand
  // and Close stay inside the panel. A 367px side panel left the name 0px.
  const [toolbarEl, toolbarRef] = useState<HTMLDivElement | null>(null);
  const [nameEl, nameRef] = useState<HTMLSpanElement | null>(null);
  const compactToolbar = useCompactRow(toolbarEl, nameEl);
  const [editSlot, editSlotRef] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen || !fullscreen) return;
    const el = contentRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: false });
    el.addEventListener("touchmove", stop, { passive: false });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
    };
  }, [isOpen, fullscreen, selectedFilePath]);

  const handleDownload = useCallback(async () => {
    if (!selectedFilePath) return;
    try {
      await source.download(selectedFilePath, fileName);
      successToast(
        tI18nHardcoded("i18nComplete.text7eca5e05f915", { value0: fileName }),
      );
    } catch {
      errorToast(
        tI18nHardcoded("i18nComplete.textc85c359673e0", { value0: fileName }),
      );
    }
  }, [selectedFilePath, source, fileName, tI18nHardcoded]);

  if (!isOpen) return null;
  // Portal to <body>: this fixed overlay is rendered inside constrained
  // containers (session side panel / Customize section) whose overflow-hidden
  // or display:none would clip or collapse it. React context is preserved.
  if (typeof document === "undefined") return null;

  const toolbar = (
    <>
      {/* The one file header every viewer shares: icon, folders / name, and
          the file's own actions (Refresh, Copy link) inside the pill. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ViewerPathPill
          icon={renderFileIcon(fileName)}
          path={selectedFilePath ?? undefined}
          fileName={fileName}
          nameRef={nameRef}
        >
          {source.useRefresh && (
            <RefreshButton onRefresh={refresh} refreshing={refreshing} />
          )}
          <ViewerActions
            shareContext={shareContext}
            shareInput={fileShareInput(selectedFilePath ?? undefined, fileName)}
          />
        </ViewerPathPill>
        {!compactToolbar && statusSlot}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* The editor's unsaved state, Save and Discard (FileContentRenderer portals them here). */}
        <div ref={editSlotRef} className="flex items-center empty:hidden" />
        {isMarkdownFile && (
          <Hint
            label={
              markdownPreview
                ? tI18nHardcoded.raw("i18nComplete.text6ee818aa2de3")
                : "Preview"
            }
            side="bottom"
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                markdownPreview
                  ? tI18nHardcoded.raw("i18nComplete.text6ee818aa2de3")
                  : "Preview"
              }
              aria-pressed={markdownPreview}
              className={cn(
                "h-8 w-8 active:scale-[0.96]",
                markdownPreview
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-foreground bg-muted",
              )}
              onClick={() => setMarkdownPreview((v) => !v)}
            >
              {markdownPreview ? (
                <Code className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </Hint>
        )}
        {filePathList.length > 1 && !compactToolbar && (
          // Previous / next live with the other actions; the arrow keys still work.
          <ButtonGroup>
            <Hint
              label={tI18nHardcoded.raw(
                "autoFeaturesFileViewerFilePreviewModalJsxAttrTitlePreviousb7cda316",
              )}
              side="bottom"
            >
              <Button
                variant="secondary"
                size="icon-base"
                disabled={!hasPrev}
                aria-label={tI18nHardcoded.raw(
                  "autoFeaturesFileViewerFilePreviewModalJsxAttrAriaLabel03ab3a76",
                )}
                className="active:scale-[0.96]"
                onClick={onPrev}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </Hint>
            <Hint
              label={tI18nHardcoded.raw(
                "autoFeaturesFileViewerFilePreviewModalJsxAttrTitleNext96666bd8",
              )}
              side="bottom"
            >
              <Button
                variant="secondary"
                size="icon-base"
                disabled={!hasNext}
                aria-label={tI18nHardcoded.raw(
                  "autoFeaturesFileViewerFilePreviewModalJsxAttrAriaLabelda6ea7e4",
                )}
                className="active:scale-[0.96]"
                onClick={onNext}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </Hint>
          </ButtonGroup>
        )}
        <ButtonGroup>
          <Hint label={historyLabel} side="bottom">
            <Button
              variant="secondary"
              size="icon-base"
              aria-label={historyLabel}
              aria-pressed={!!historyPath}
              className={cn("active:scale-[0.96]", historyPath && "bg-accent")}
              onClick={() =>
                setHistoryPath(historyPath ? null : selectedFilePath)
              }
            >
              <History className="h-4 w-4" />
            </Button>
          </Hint>
          {exportsPdf && !compactToolbar && (
            <SaveAsPdfButton
              fileName={fileName}
              content={
                pdfSource?.type === "text" ? pdfSource.content : undefined
              }
              variant="secondary"
              className="h-8 w-8"
              iconClassName="h-4 w-4"
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5 active:scale-[0.96]"
            onClick={handleDownload}
            aria-label={tI18nHardcoded.raw("i18nComplete.textd6eafe823591")}
          >
            <Download className="h-3.5 w-3.5" />
            {!compactToolbar &&
              tI18nHardcoded.raw("i18nComplete.textd6eafe823591")}
          </Button>
        </ButtonGroup>
        {extraActions}
        {embedded && (
          <Hint
            label={
              expanded
                ? tI18nHardcoded.raw("i18nComplete.textde12e3c7c7a8")
                : "Expand"
            }
            side="bottom"
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                expanded
                  ? tI18nHardcoded.raw("i18nComplete.textde12e3c7c7a8")
                  : "Expand"
              }
              aria-pressed={expanded}
              className="text-muted-foreground hover:text-foreground h-8 w-8 active:scale-[0.96]"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>
          </Hint>
        )}
        <ButtonGroup className="ml-1.5">
          <Hint
            label={tI18nHardcoded.raw(
              "autoFeaturesFileViewerFilePreviewModalJsxAttrTitleClosea40d0510",
            )}
            side="bottom"
          >
            <Button
              variant="secondary"
              size="icon-base"
              aria-label={tI18nHardcoded.raw(
                "autoFeaturesFileViewerFilePreviewModalJsxAttrTitleClosea40d0510",
              )}
              className="active:scale-[0.96]"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </Hint>
        </ButtonGroup>
      </div>
    </>
  );

  const body = (
    <>
      {/* Breathing room on every side, so line numbers and content never touch the frame. */}
      <div className="h-full w-full overflow-hidden px-3 pt-3 pb-2">
        <FileSourceProvider value={source}>
          <FileContentRenderer
            filePath={selectedFilePath!}
            reloadKey={reloadKey}
            onUnsavedChange={setDirty}
            showHeader={!!source.editablePreview}
            headerSlot={editSlot}
            readOnly={!source.editablePreview}
            targetLine={targetLine}
            markdownPreview={markdownPreview}
            onMarkdownPreviewChange={setMarkdownPreview}
          />
        </FileSourceProvider>
      </div>

      {historyPath && (
        <div className="bg-popover border-border/60 animate-in slide-in-from-bottom-4 fade-in-0 absolute right-4 bottom-4 z-30 overflow-hidden rounded-md border shadow-md duration-normal">
          <HistoryContent
            filePath={historyPath}
            onClose={() => setHistoryPath(null)}
          />
        </div>
      )}
    </>
  );

  const panelInner = (
    <>
      <div
        ref={toolbarRef}
        data-file-toolbar=""
        className="border-border/40 bg-background/95 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur-sm"
      >
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
        aria-label={tI18nHardcoded("i18nComplete.text4a7346d46cf6", {
          value0: fileName ? `: ${fileName}` : "",
        })}
        tabIndex={-1}
        className="bg-background animate-in fade-in-0 absolute inset-0 z-20 flex flex-col overflow-hidden duration-normal outline-none"
      >
        {panelInner}
      </div>
    );
  }

  const node = (
    <DialogDepthProvider depth={dialogDepth}>
      <div
        data-file-preview-overlay=""
        className="animate-in fade-in-0 pointer-events-auto fixed inset-0 bg-black/50 backdrop-blur-sm duration-normal"
        style={{ zIndex: dialogOverlayZ(dialogDepth) }}
        aria-hidden="true"
        onClick={embedded ? () => setExpanded(false) : onClose}
      />
      <div
        ref={surfaceRef}
        data-file-preview-overlay=""
        role="dialog"
        aria-modal="true"
        aria-label={tI18nHardcoded("i18nComplete.text4a7346d46cf6", {
          value0: fileName ? `: ${fileName}` : "",
        })}
        tabIndex={-1}
        className="kx-fullscreen-modal border-border/60 bg-background animate-in fade-in-0 zoom-in-[0.98] pointer-events-auto fixed inset-3 flex flex-col overflow-hidden rounded-xl border shadow-lg duration-normal outline-none sm:inset-4"
        style={{ zIndex: dialogContentZ(dialogDepth) }}
      >
        {panelInner}
      </div>
    </DialogDepthProvider>
  );

  return createPortal(node, document.body);
}

/** Below this the file name stops being readable, so the row compacts first. */
const MIN_NAME_PX = 96;

/**
 * True once the row overflows its width or squeezes the name below
 * `MIN_NAME_PX`, and until the row grows wider than the width where that
 * happened. The width is the hysteresis: the compact row fits, so "does it
 * overflow now" alone would flip back and forth.
 *
 * The name check exists because the row never overflows on its own: the name
 * column shrinks first (`min-w-0`), so a 367px side panel showed the actions
 * and a 1px name.
 */
function useCompactRow(
  el: HTMLElement | null,
  name: HTMLElement | null,
): boolean {
  const [compactAt, setCompactAt] = useState<number | null>(null);
  const check = useCallback(() => {
    if (!el) return;
    setCompactAt((at) => {
      if (at !== null) return el.clientWidth > at ? null : at;
      const nameSqueezed =
        !!name && name.clientWidth < Math.min(name.scrollWidth, MIN_NAME_PX);
      return el.scrollWidth > el.clientWidth || nameSqueezed
        ? el.clientWidth
        : null;
    });
  }, [el, name]);
  // Every commit: a new file can bring more actions at the same width.
  useLayoutEffect(check);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    // The row for its width, its groups for their content (a late font or a
    // host stylesheet widens the actions without resizing the row).
    const observer = new ResizeObserver(check);
    for (const node of [el, ...Array.from(el.children)]) observer.observe(node);
    return () => observer.disconnect();
  }, [el, check]);
  return compactAt !== null;
}
