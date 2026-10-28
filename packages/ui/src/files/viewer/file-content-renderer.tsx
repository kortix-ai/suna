'use client';

import { useTranslations } from '../../i18n';

import { ErrorBoundary } from '../../primitives/error-boundary';
import { CodeEditor } from '../editor/lazy-code-editor';
import { MarkdownWithFrontmatter } from '../../markdown/markdown-frontmatter';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { InfoBanner } from '../../primitives/info-banner';
import Loading from '../../primitives/loading';
import { StatusDot } from '../../primitives/status';
import { MermaidDiagram } from '../renderers/mermaid/mermaid-diagram';
import { cn } from '../../lib/utils';
import { toSandboxAbsolutePath } from '@kortix/sdk';
import {
  WarningIcon as AlertTriangle,
  BracketsCurlyIcon as Braces,
  CheckIcon as Check,
  WarningCircleIcon as CircleAlert,
  CodeIcon as Code,
  EyeIcon as Eye,
  GitDiffIcon as FileDiff,
  FileXIcon as FileWarning,
  FileXIcon as FileX,
  GlobeIcon as Globe,
  ArrowCounterClockwiseIcon as RotateCcw,
  FloppyDiskIcon as Save,
} from '@phosphor-icons/react';
import React, { lazy, Suspense, useCallback } from 'react';
// Direct module import, not the feature barrel: the barrel re-exports THIS file.
import { HtmlPreview } from './html-preview';
import { JsonTreeView } from './json-tree-view';
import { FileHeader } from './file-header';
import { useFileContentState } from './use-file-content-state';
import { type FileCaption, useFileCaption } from '../../internal/stores/file-preview-store';
import { Download } from '../../internal/icons/download';

// ---------------------------------------------------------------------------
// Lazy-load heavy renderers to keep initial bundle small
// ---------------------------------------------------------------------------

const PdfRenderer = lazy(() =>
  import('../renderers/pdf/pdf-renderer').then((m) => ({ default: m.PdfRenderer })),
);
const DocxRenderer = lazy(() =>
  import('../renderers/docx/docx-renderer').then((m) => ({ default: m.DocxRenderer })),
);
const VideoRenderer = lazy(() =>
  import('../renderers/video-renderer').then((m) => ({ default: m.VideoRenderer })),
);
const CsvRenderer = lazy(() =>
  import('../renderers/csv/csv-renderer').then((m) => ({ default: m.CsvRenderer })),
);
const XlsxRenderer = lazy(() =>
  import('../renderers/xlsx/xlsx-renderer').then((m) => ({ default: m.XlsxRenderer })),
);
const PptxRenderer = lazy(() =>
  import('../renderers/pptx-renderer').then((m) => ({ default: m.PptxRenderer })),
);
const ImageRenderer = lazy(() =>
  import('../renderers/image-renderer').then((m) => ({ default: m.ImageRenderer })),
);
const SqliteRenderer = lazy(() =>
  import('../renderers/sqlite-renderer').then((m) => ({
    default: m.SqliteRenderer,
  })),
);
const ZipRenderer = lazy(() =>
  import('../renderers/zip/zip-renderer').then((m) => ({ default: m.ZipRenderer })),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spinner placeholder used inside <Suspense> for lazy-loaded renderers. */
function RendererFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loading className="text-muted-foreground/40 h-4 w-4" />
    </div>
  );
}

/** Shared "file does not exist" UI shown when a file cannot be loaded. */
/**
 * An image with its caption under it: a generated image's prompt and the model
 * that made it. Only an image opened with a caption has one; any other file
 * renders exactly as without it.
 */
function CaptionedImage({ caption, children }: { caption: FileCaption | undefined; children: React.ReactNode }) {
  if (!caption) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      <div data-file-caption="" className="border-border max-h-32 shrink-0 overflow-y-auto border-t px-4 py-3">
        <p className="text-foreground text-sm text-pretty">{caption.text}</p>
        {caption.model ? <p className="text-muted-foreground mt-1 font-mono text-xs">{caption.model}</p> : null}
      </div>
    </div>
  );
}

function FileNotFoundState({ filePath }: { filePath: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted/50 flex h-12 w-12 items-center justify-center rounded-sm">
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
  /** Render the header's edit controls into this host toolbar instead of a
   *  row of their own (`FilePreviewModal`). The host owns the path and Download. */
  headerSlot?: HTMLElement | null;
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
  /**
   * Optional: report load status to the caller. Used by `show` tool cards to
   * hide a dead/renamed file reference (→ 'error') instead of rendering the
   * "file does not exist" state. No effect on the default viewer chrome.
   */
  onStatusChange?: (status: 'loading' | 'ready' | 'error') => void;
  /** The image shelf (zoom, rotate). `'none'` for a thumbnail. Default `'hover'`. */
  imageControls?: 'hover' | 'always' | 'none';
  /** PDF only: start the zoom plugin at fit-to-page instead of the numeric
   *  default. No effect on any other file category. */
  fitOnOpen?: boolean;
  /** PDF only: search for this text once the file opens. Hits are highlighted and
   *  the first one is scrolled into view (a citation's quote, for example). */
  findText?: string;
  /** Additional class name for the code editor */
  codeEditorEditorClassName?: string;
  /** Bumped by the surface's Refresh control. Remounts the renderers that read
   *  their own bytes (xlsx, sqlite, the HTML frame), which a cache refetch
   *  cannot reach. */
  reloadKey?: number;
}

export function FileContentRenderer({
  filePath,
  showHeader = true,
  headerSlot,
  headerActions,
  onUnsavedChange,
  onSaved,
  className,
  errorFallback,
  targetLine,
  readOnly = false,
  markdownPreview,
  onMarkdownPreviewChange,
  onStatusChange,
  imageControls,
  fitOnOpen = false,
  findText,
  codeEditorEditorClassName,
  reloadKey = 0,
}: FileContentRendererProps) {
  const {
    source, Breadcrumbs, fileContent, isLoading, error,
    contentRevision, fetchRevision, hasUnsavedChanges, setHasUnsavedChanges, isSaving,
    saveFlash, latestContentRef, discardKey, fileName, isHeicImage,
    language, fileCategory, isMarkdownFile, isMermaidFile, hasPreviewToggle,
    isJsonFile, isHtmlFile, isMarkdownPreview, setIsMarkdownPreview, isJsonTreeView,
    setIsJsonTreeView, isHtmlPreview, setIsHtmlPreview, fileDiagErrorCount, fileDiagWarningCount,
    fileDiagnostics, tHardcodedUi, tI18nHardcoded, blobUrl, rawBlob,
    blobLoading, blobError, heicImageUrl, heicConverting, displayContent,
    handleDownload, handleSave, handleDiscard, handleEditorChange, imageDataUrl,
    needsBlob, isContentReady, contentError, showLoadingState, isSandboxWaking,
    isNotFound,
  } = useFileContentState({
    filePath,
    onUnsavedChange,
    onSaved,
    readOnly,
    markdownPreview,
    onMarkdownPreviewChange,
    onStatusChange,
    targetLine,
  });
  const caption = useFileCaption(filePath);
  const bytesOnly = !!source.bytesOnly;
  // The table has no lines: a jump to a line (a content-search match) opens
  // CSV and TSV in the code editor.
  const csvAsTable = fileCategory === 'csv' && !targetLine;
  const saveThroughSource = useCallback(
    (file: File) =>
      source.save
        ? source.save(filePath, file)
        : source.upload(file, filePath.substring(0, filePath.lastIndexOf('/')) || undefined),
    [source, filePath],
  );

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

  const discardLabel: string = tHardcodedUi.raw(
    'featuresFilesComponentsFileContentRenderer.line600JsxAttrTitleDiscardChanges',
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <FileHeader {...{ showHeader, headerSlot, Breadcrumbs, filePath, readOnly, hasUnsavedChanges, saveFlash, fileDiagErrorCount, fileDiagWarningCount, fileContent, isSaving, handleSave, latestContentRef, discardLabel, handleDiscard, isHtmlFile, isHtmlPreview, setIsHtmlPreview, isJsonFile, isJsonTreeView, setIsJsonTreeView, hasPreviewToggle, isMarkdownPreview, setIsMarkdownPreview, headerActions, handleDownload, blobUrl, rawBlob, tI18nHardcoded, tHardcodedUi }} />

      {/* Content area — readOnly uses overflow-auto so the read-only editor
          (which renders at auto height) can scroll within the fixed-size parent. */}
      <div className={cn('flex-1', readOnly ? 'overflow-auto' : 'overflow-hidden')}>
        <ErrorBoundary
          fallback={() => (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-sm">
                <FileWarning className="text-destructive/50 h-6 w-6" />
              </div>
              <p className="text-muted-foreground text-sm font-medium">
                {tI18nHardcoded.raw(
                  'autoFeaturesFileViewerFileContentRendererJsxTextCouldnT794ae800',
                )}
              </p>
              <p className="text-muted-foreground/50 max-w-sm font-mono text-xs break-all">
                {filePath}
              </p>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {tI18nHardcoded.raw('i18nComplete.textd6eafe823591')}
              </Button>
            </div>
          )}
        >
          {/* Loading */}
          {showLoadingState && (
            <div className="flex h-full items-center justify-center">
              <Loading className="text-muted-foreground/40 h-4 w-4" />
            </div>
          )}

          {/* Sandbox waking — the workspace is parked or booting; the file
              hooks keep polling and the content replaces this on its own.
              Takes precedence over errorFallback: a waking box is not an
              error, so no surface gets to render it as one. */}
          {contentError && !showLoadingState && isSandboxWaking && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <Loading className="text-muted-foreground/40 h-4 w-4" />
              <p className="text-muted-foreground text-sm font-medium">
                {tI18nHardcoded.raw('i18nComplete.text5e3de76869f3')}
              </p>
              <p className="text-muted-foreground/50 max-w-sm font-mono text-xs break-all">
                {filePath}
              </p>
              <p className="text-muted-foreground/40 max-w-xs text-xs">
                {tI18nHardcoded.raw('i18nComplete.textd4707c58c4a4')}
              </p>
            </div>
          )}

          {/* Error */}
          {contentError &&
            !showLoadingState &&
            !isSandboxWaking &&
            (errorFallback ? (
              errorFallback(contentError, filePath)
            ) : isNotFound ? (
              <FileNotFoundState filePath={filePath} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-sm">
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
            <CaptionedImage caption={caption}>
              <Suspense fallback={<RendererFallback />}>
                <ImageRenderer
                  url={imageDataUrl}
                  className="h-full"
                  fileName={fileName}
                  controls={imageControls}
                />
              </Suspense>
            </CaptionedImage>
          )}

          {/* HEIC image — loaded as raw blob, converted to JPEG client-side */}
          {isHeicImage && (blobLoading || heicConverting) && <RendererFallback />}
          {isHeicImage && !blobLoading && !blobError && heicImageUrl && !heicConverting && (
            <CaptionedImage caption={caption}>
              <Suspense fallback={<RendererFallback />}>
                <ImageRenderer
                  url={heicImageUrl}
                  className="h-full"
                  fileName={fileName}
                  controls={imageControls}
                />
              </Suspense>
            </CaptionedImage>
          )}

          {/* The rich renderers below get `showDownload={false}`: every host of
              this component (the session panel, the file preview modal, the
              public share page) already shows Download in its own toolbar, and
              a second one inside the viewer is the duplicate we removed. */}

          {/* PDF preview */}
          {isContentReady && fileCategory === 'pdf' && fileContent?.content && (
            <Suspense fallback={<RendererFallback />}>
              <PdfRenderer
                fileContent={fileContent.content}
                fileName={fileName}
                className="h-full"
                fitOnOpen={fitOnOpen}
                findText={findText}
                showDownload={false}
              />
            </Suspense>
          )}

          {/* DOCX preview */}
          {isContentReady && fileCategory === 'docx' && rawBlob && (
            <Suspense fallback={<RendererFallback />}>
              <DocxRenderer
                blob={rawBlob}
                fileName={fileName}
                className="h-full"
                showDownload={false}
              />
            </Suspense>
          )}

          {/* Zip archive — browse the entries, drill into one, extract it */}
          {isContentReady && fileCategory === 'zip' && rawBlob && (
            <Suspense fallback={<RendererFallback />}>
              {/* `key`: the renderer holds per-archive state (which folders
                  are open, which entry is drilled into), and switching files
                  must not carry one archive's expansion onto another's paths.
                  Remounting is React's own reset, and it costs nothing — the
                  blob is already cached by the source. */}
              <ZipRenderer key={filePath} blob={rawBlob} fileName={fileName} className="h-full" />
            </Suspense>
          )}

          {/* XLSX / XLS preview */}
          {!isLoading && !error && !isNotFound && fileCategory === 'xlsx' && (!bytesOnly || blobUrl) && (
            <Suspense fallback={<RendererFallback />}>
              <XlsxRenderer
                key={`xlsx-${filePath}-${contentRevision}-${reloadKey}`}
                // A bytes-only source hands the workbook over as a blob URL;
                // the renderer reads a sandbox path only for a session.
                filePath={bytesOnly ? blobUrl! : filePath}
                fileName={fileName}
                className="h-full"
                showDownload={false}
              />
            </Suspense>
          )}

          {/* SQLite database viewer */}
          {!isLoading && !error && !isNotFound && fileCategory === 'sqlite' && (!bytesOnly || rawBlob) && (
            <Suspense fallback={<RendererFallback />}>
              <SqliteRenderer
                key={`sqlite-${filePath}-${contentRevision}-${reloadKey}`}
                filePath={filePath}
                fileName={fileName}
                className="h-full"
                readOnly={readOnly}
                {...(bytesOnly ? { bytes: rawBlob, onSave: saveThroughSource } : {})}
              />
            </Suspense>
          )}

          {/* CSV / TSV preview */}
          {!isLoading && !error && csvAsTable && fileContent && (
            <Suspense fallback={<RendererFallback />}>
              <CsvRenderer
                content={fileContent.content}
                fileName={fileName}
                className="h-full"
                showDownload={false}
              />
            </Suspense>
          )}

          {/* Video preview */}
          {isContentReady && fileCategory === 'video' && blobUrl && (
            <Suspense fallback={<RendererFallback />}>
              <VideoRenderer url={blobUrl} className="h-full" />
            </Suspense>
          )}

          {/* Audio preview */}
          {isContentReady && fileCategory === 'audio' && blobUrl && (
            <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
              <div className="bg-muted/50 flex h-14 w-14 items-center justify-center rounded-sm">
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

          {/* HTML preview — served by the sandbox's static file server, so the
              page's own relative assets resolve. `HtmlPreview` owns the wait,
              the retry and the frame; the session panel renders the same one. */}
          {isHtmlFile && isHtmlPreview && (
            <HtmlPreview
              key={`html-preview-${filePath}`}
              path={toSandboxAbsolutePath(filePath)}
              reloadKey={`${fetchRevision}-${reloadKey}`}
              fileName={fileName}
              pendingLabel={tHardcodedUi.raw(
                'featuresFilesComponentsFileContentRenderer.line805JsxTextStartingPreviewServer',
              )}
            />
          )}

          {/* HTML source — shown when preview toggle is off */}
          {isHtmlFile && !isHtmlPreview && !isLoading && !error && fileContent?.type === 'text' && (
            <CodeEditor
              editorClassName={codeEditorEditorClassName}
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
                <div className="bg-muted/50 flex h-12 w-12 items-center justify-center rounded-sm">
                  <FileWarning className="text-muted-foreground/30 h-6 w-6" />
                </div>
                <p className="text-muted-foreground/50 text-sm">
                  {tHardcodedUi.raw(
                    'featuresFilesComponentsFileContentRenderer.line844JsxTextBinaryFile',
                  )}
                </p>
                <Button variant="outline" size="sm" className="" onClick={handleDownload}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {tI18nHardcoded.raw('i18nComplete.textd6eafe823591')}
                </Button>
              </div>
            )}

          {/* Text / code content */}
          {!isLoading &&
            !error &&
            fileContent &&
            fileContent.type === 'text' &&
            !imageDataUrl &&
            !csvAsTable &&
            // HTML has its own preview/source branches above, except from a
            // bytes-only source: there it is plain text in the editor.
            !isHtmlFile && (
              <div
                className={cn(
                  'relative flex flex-col',
                  // The diagram fits the pane, so it needs a definite height
                  // even read-only; `min-h-full` would collapse it to zero.
                  readOnly && !(isMermaidFile && isMarkdownPreview) ? 'min-h-full' : 'h-full',
                )}
              >
                {/* Diff indicator */}
                {fileContent.patch && fileContent.patch.hunks.length > 0 && (
                  <InfoBanner
                    tone="warning"
                    icon={FileDiff}
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
                ) : isMarkdownPreview && isMermaidFile ? (
                  // Reads the unsaved editor text, like the markdown preview
                  // below, so an edit in Source shows up here before saving.
                  <MermaidDiagram
                    key={filePath}
                    source={hasUnsavedChanges ? latestContentRef.current : displayContent}
                    fileName={fileName}
                    onShowSource={() => setIsMarkdownPreview(false)}
                    className="h-full"
                  />
                ) : isMarkdownPreview && isMarkdownFile ? (
                  // Markdown is prose, so it gets a measure. The markdown root
                  // renders at text-base (16px); full-bleed on a wide viewport that
                  // is ~190 characters per line, well past the comfortable
                  // 65-90. `max-w-2xl` is the same reading column the customize
                  // sections use, and it is a no-op in panels already narrower
                  // than 672px. Deliberately not applied to the code editor:
                  // code line length is the author's decision, and a narrow
                  // column would only add horizontal scrolling.
                  //
                  // The cap sits on an inner element so the scroll container
                  // stays full width and its scrollbar rides the panel edge.
                  <div key={filePath} className="h-full w-full overflow-auto p-6 pb-40">
                    <div className="mx-auto w-full max-w-2xl">
                      <MarkdownWithFrontmatter
                        content={hasUnsavedChanges ? latestContentRef.current : displayContent}
                        documentPath={filePath}
                      />
                    </div>
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
        </ErrorBoundary>
      </div>
    </div>
  );
}
