'use client';

import { useTranslations } from '@/i18n/use-translations';

import { ClientErrorBoundary } from '@/components/common/error-boundary';
import { ViewerNotice } from './viewer-notice';
import { FileCategoryContent } from './file-category-content';
import { CodeEditor } from '@/components/file-editors/lazy-code-editor';
import { MarkdownWithFrontmatter } from '@/components/markdown/markdown-frontmatter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { StatusDot } from '@/components/ui/status';
import { MermaidDiagram } from '@/features/file-renderers/mermaid/mermaid-diagram';
import { cn } from '@/lib/utils';
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
import React from 'react';
// Direct module import, not the feature barrel: the barrel re-exports THIS file.
import { HtmlPreview } from './html-preview';
import { JsonTreeView } from './json-tree-view';
import { FileHeader } from './file-header';
import { useFileContentState } from './use-file-content-state';
import { Download } from '@/features/icon/icons/download';

/** The two icon tiles the notices sit on — the failed look and the missing look. */
const notFoundMedia = (
  <div className="bg-muted/50 flex h-12 w-12 items-center justify-center rounded-sm">
    <FileX className="text-muted-foreground/40 h-6 w-6" />
  </div>
);
const errorMedia = (
  <div className="bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-sm">
    <FileWarning className="text-destructive/50 h-6 w-6" />
  </div>
);

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
  /**
   * Optional: report load status to the caller. Used by `show` tool cards to
   * hide a dead/renamed file reference (→ 'error') instead of rendering the
   * "file does not exist" state. No effect on the default viewer chrome.
   */
  onStatusChange?: (status: 'loading' | 'ready' | 'error') => void;
  /** PDF only: start the zoom plugin at fit-to-page instead of the numeric
   *  default. No effect on any other file category. */
  fitOnOpen?: boolean;
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
  fitOnOpen = false,
  codeEditorEditorClassName,
  reloadKey = 0,
}: FileContentRendererProps) {
  const state = useFileContentState({
    filePath,
    onUnsavedChange,
    onSaved,
    readOnly,
    markdownPreview,
    onMarkdownPreviewChange,
    onStatusChange,
    targetLine,
  });
  const {
    Breadcrumbs, fileContent, isLoading, error,
    fetchRevision, hasUnsavedChanges, setHasUnsavedChanges, isSaving,
    saveFlash, latestContentRef, discardKey, fileName, isHeicImage,
    language, fileCategory, isMarkdownFile, isMermaidFile, hasPreviewToggle,
    isJsonFile, isHtmlFile, isMarkdownPreview, setIsMarkdownPreview, isJsonTreeView,
    setIsJsonTreeView, isHtmlPreview, setIsHtmlPreview, fileDiagErrorCount, fileDiagWarningCount,
    fileDiagnostics, tHardcodedUi, tI18nHardcoded, blobUrl, rawBlob,
    displayContent,
    handleDownload, handleSave, handleDiscard, handleEditorChange, imageDataUrl,
    contentError, showLoadingState, isSandboxWaking,
    isNotFound, csvAsTable,
  } = state;

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

  // The not-found notice is reachable from two disjoint paths — a not-found
  // ERROR from a source that failed, and a query that settled with nothing
  // from one that didn't. One element, two mounts.
  const notFoundNotice = (
    <ViewerNotice
      media={notFoundMedia}
      title={tHardcodedUi.raw('featuresFilesComponentsFileContentRenderer.line195JsxTextFileNotFound')}
      path={filePath}
      detail={tHardcodedUi.raw(
        'featuresFilesComponentsFileContentRenderer.line201JsxTextThisFileDoesNotExistOrMayHave',
      )}
    />
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <FileHeader {...{ showHeader, Breadcrumbs, filePath, readOnly, hasUnsavedChanges, saveFlash, fileDiagErrorCount, fileDiagWarningCount, fileContent, isSaving, handleSave, latestContentRef, discardLabel, handleDiscard, isHtmlFile, isHtmlPreview, setIsHtmlPreview, isJsonFile, isJsonTreeView, setIsJsonTreeView, hasPreviewToggle, isMarkdownPreview, setIsMarkdownPreview, headerActions, handleDownload, blobUrl, rawBlob, tI18nHardcoded, tHardcodedUi }} />

      {/* Content area — readOnly uses overflow-auto so the read-only editor
          (which renders at auto height) can scroll within the fixed-size parent. */}
      <div className={cn('flex-1', readOnly ? 'overflow-auto' : 'overflow-hidden')}>
        <ClientErrorBoundary
          fallback={() => (
            <ViewerNotice
              media={errorMedia}
              title={tI18nHardcoded.raw(
                'autoFeaturesFileViewerFileContentRendererJsxTextCouldnT794ae800',
              )}
              path={filePath}
              action={
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {tI18nHardcoded.raw('i18nComplete.textd6eafe823591')}
                </Button>
              }
            />
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
            <ViewerNotice
              media={<Loading className="text-muted-foreground/40 h-4 w-4" />}
              title={tI18nHardcoded.raw('i18nComplete.text5e3de76869f3')}
              path={filePath}
              detail={tI18nHardcoded.raw('i18nComplete.textd4707c58c4a4')}
            />
          )}

          {/* Error */}
          {contentError &&
            !showLoadingState &&
            !isSandboxWaking &&
            (errorFallback ? (
              errorFallback(contentError, filePath)
            ) : isNotFound ? (
              notFoundNotice
            ) : (
              <ViewerNotice
                media={errorMedia}
                title={tHardcodedUi.raw(
                  'featuresFilesComponentsFileContentRenderer.line692JsxTextFailedToLoadFile',
                )}
                path={filePath}
                detail={contentError}
              />
            ))}

          {/* The category renderer — one switch over FileCategory behind one
              Suspense boundary, in its own module. */}
          <FileCategoryContent {...{ state, filePath, fitOnOpen, reloadKey }} />


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
              <ViewerNotice
                media={
                  <div className="bg-muted/50 flex h-12 w-12 items-center justify-center rounded-sm">
                    <FileWarning className="text-muted-foreground/30 h-6 w-6" />
                  </div>
                }
                title={tHardcodedUi.raw(
                  'featuresFilesComponentsFileContentRenderer.line844JsxTextBinaryFile',
                )}
                action={
                  <Button variant="outline" size="sm" onClick={handleDownload}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {tI18nHardcoded.raw('i18nComplete.textd6eafe823591')}
                  </Button>
                }
              />
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
                  // renders at text-[15px]; full-bleed on a wide viewport that
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
          {!showLoadingState && !contentError && isNotFound && notFoundNotice}
        </ClientErrorBoundary>
      </div>
    </div>
  );
}
