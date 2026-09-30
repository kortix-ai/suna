'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { StatusDot } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { WarningIcon as AlertTriangle, BracketsCurlyIcon as Braces, CheckIcon as Check, WarningCircleIcon as CircleAlert, CodeIcon as Code, EyeIcon as Eye, GlobeIcon as Globe, ArrowCounterClockwiseIcon as RotateCcw, FloppyDiskIcon as Save } from '@phosphor-icons/react';
import type { ComponentType, ReactNode, Dispatch, SetStateAction, MutableRefObject } from 'react';
import type { FileContent } from './file-source';
import { Download } from '@/features/icon/icons/download';

interface FileHeaderProps {
  showHeader: boolean;
  Breadcrumbs: ComponentType<{ filePath: string }> | undefined;
  filePath: string;
  readOnly: boolean;
  hasUnsavedChanges: boolean;
  saveFlash: boolean;
  fileDiagErrorCount: number;
  fileDiagWarningCount: number;
  fileContent: FileContent | undefined;
  isSaving: boolean;
  handleSave: (content: string) => Promise<void>;
  latestContentRef: MutableRefObject<string>;
  discardLabel: string;
  handleDiscard: () => void;
  isHtmlFile: boolean;
  isHtmlPreview: boolean;
  setIsHtmlPreview: Dispatch<SetStateAction<boolean>>;
  isJsonFile: boolean;
  isJsonTreeView: boolean;
  setIsJsonTreeView: Dispatch<SetStateAction<boolean>>;
  hasPreviewToggle: boolean;
  isMarkdownPreview: boolean;
  setIsMarkdownPreview: (next: boolean | ((prev: boolean) => boolean)) => void;
  headerActions: ReactNode;
  handleDownload: () => Promise<void>;
  blobUrl: string | null;
  rawBlob: Blob | null;
  tI18nHardcoded: ReturnType<typeof import("@/i18n/use-translations").useTranslations>;
  tHardcodedUi: ReturnType<typeof import("@/i18n/use-translations").useTranslations>;
}

export function FileHeader({ showHeader, Breadcrumbs, filePath, readOnly, hasUnsavedChanges, saveFlash, fileDiagErrorCount, fileDiagWarningCount, fileContent, isSaving, handleSave, latestContentRef, discardLabel, handleDiscard, isHtmlFile, isHtmlPreview, setIsHtmlPreview, isJsonFile, isJsonTreeView, setIsJsonTreeView, hasPreviewToggle, isMarkdownPreview, setIsMarkdownPreview, headerActions, handleDownload, blobUrl, rawBlob, tI18nHardcoded, tHardcodedUi }: FileHeaderProps) {
  return (
      <>
      {/* Header */}
      {showHeader && (
        <div className="border-border/50 flex h-10 shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {Breadcrumbs && <Breadcrumbs filePath={filePath} />}
            {/* Edit state indicator */}
            {!readOnly && hasUnsavedChanges && (
              <Badge variant="warning" size="sm" className="shrink-0">
                <StatusDot tone="warning" pulse />
                {tI18nHardcoded.raw('i18nComplete.text7117f0807129')}
              </Badge>
            )}
            {!readOnly && saveFlash && !hasUnsavedChanges && (
              <Badge variant="success" size="sm" className="shrink-0">
                <Check className="h-3 w-3" />
                {tI18nHardcoded.raw('i18nComplete.textb5c120b316c2')}
              </Badge>
            )}
            {readOnly && (
              <Badge variant="muted" size="sm" className="shrink-0 tracking-wider uppercase">
                {tHardcodedUi.raw(
                  'featuresFilesComponentsFileContentRenderer.line554JsxTextViewOnly',
                )}
              </Badge>
            )}
            {/* Inline diagnostic counts */}
            {(fileDiagErrorCount > 0 || fileDiagWarningCount > 0) && (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                {fileDiagErrorCount > 0 && (
                  <span className="text-destructive inline-flex items-center gap-0.5 text-xs font-medium tabular-nums">
                    <CircleAlert className="h-3 w-3" />
                    {fileDiagErrorCount}
                  </span>
                )}
                {fileDiagWarningCount > 0 && (
                  <span className="text-kortix-orange inline-flex items-center gap-0.5 text-xs font-medium tabular-nums">
                    <AlertTriangle className="h-3 w-3" />
                    {fileDiagWarningCount}
                  </span>
                )}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {/* Explicit Save button — only when editing and has changes */}
            {!readOnly && hasUnsavedChanges && fileContent?.type === 'text' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 gap-1.5 px-3 text-xs font-medium"
                  onClick={() => handleSave(latestContentRef.current)}
                  disabled={isSaving}
                  title={tHardcodedUi.raw(
                    'featuresFilesComponentsFileContentRenderer.line586JsxAttrTitleSaveS',
                  )}
                >
                  {isSaving ? (
                    <Loading className="h-3.5 w-3.5" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {tI18nHardcoded.raw('i18nComplete.text1509f561f241')}
                </Button>
                <Hint label={discardLabel} side="bottom">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={discardLabel}
                    className="text-muted-foreground hover:text-foreground h-7 w-7 active:scale-[0.96]"
                    onClick={handleDiscard}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </Hint>
              </>
            )}

            {/* HTML preview toggle */}
            {isHtmlFile && (
              <Hint
                label={
                  isHtmlPreview ? tI18nHardcoded.raw('i18nComplete.text6ee818aa2de3') : 'Preview'
                }
                side="bottom"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    isHtmlPreview ? tI18nHardcoded.raw('i18nComplete.text6ee818aa2de3') : 'Preview'
                  }
                  aria-pressed={isHtmlPreview}
                  className={cn('h-7 w-7 active:scale-[0.96]', isHtmlPreview && 'text-primary')}
                  onClick={() => setIsHtmlPreview((v) => !v)}
                >
                  {isHtmlPreview ? <Code className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
                </Button>
              </Hint>
            )}

            {/* JSON tree toggle */}
            {isJsonFile && fileContent?.type === 'text' && (
              <Hint
                label={
                  isJsonTreeView
                    ? tI18nHardcoded.raw('i18nComplete.text6ee818aa2de3')
                    : tI18nHardcoded.raw('i18nComplete.text4f50bda41e87')
                }
                side="bottom"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    isJsonTreeView
                      ? tI18nHardcoded.raw('i18nComplete.text6ee818aa2de3')
                      : tI18nHardcoded.raw('i18nComplete.text4f50bda41e87')
                  }
                  aria-pressed={isJsonTreeView}
                  className={cn('h-7 w-7 active:scale-[0.96]', isJsonTreeView && 'text-primary')}
                  onClick={() => setIsJsonTreeView((v) => !v)}
                >
                  <Braces className="h-4 w-4" />
                </Button>
              </Hint>
            )}

            {/* Markdown / Mermaid preview toggle */}
            {hasPreviewToggle && fileContent?.type === 'text' && (
              <Hint
                label={
                  isMarkdownPreview
                    ? tI18nHardcoded.raw('i18nComplete.text6ee818aa2de3')
                    : 'Preview'
                }
                side="bottom"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    isMarkdownPreview
                      ? tI18nHardcoded.raw('i18nComplete.text6ee818aa2de3')
                      : 'Preview'
                  }
                  aria-pressed={isMarkdownPreview}
                  className={cn('h-7 w-7 active:scale-[0.96]', isMarkdownPreview && 'text-primary')}
                  onClick={() => setIsMarkdownPreview((v) => !v)}
                >
                  {isMarkdownPreview ? <Code className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </Hint>
            )}

            {/* Additional header actions from parent */}
            {headerActions}

            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-3 text-xs font-medium"
              onClick={handleDownload}
              disabled={!fileContent && !blobUrl && !rawBlob}
              aria-label={tI18nHardcoded.raw('i18nComplete.textd6eafe823591')}
            >
              <Download className="h-3.5 w-3.5" />
              {tI18nHardcoded.raw('i18nComplete.textd6eafe823591')}
            </Button>
          </div>
        </div>
      )}
      </>
  );
}
