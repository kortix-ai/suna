'use client';

import { useTranslations } from 'next-intl';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Download,
  ChevronLeft,
  ChevronRight,
  History,
  Code,
  Eye,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDialogDepth, dialogOverlayZ, dialogContentZ } from '@/lib/z-stack';
import { useFilesStore } from '../store/files-store';
import { FileContentRenderer, getLanguageFromExt } from './file-content-renderer';
import { FileHistoryPopoverContent } from './file-history-popover';
import { getFileIcon } from './file-icon';
import { downloadFile } from '../api/opencode-files';
import { useProjectContext } from '../context';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

/**
 * Full-screen file preview modal.
 *
 * Layout (Vercel-inspired):
 *  - One full-bleed surface (no nested card-in-card chrome)
 *  - Slim top bar: back, file icon + name, counter, action group, close
 *  - Body fills the remaining viewport; renderer is responsible for its own
 *    horizontal/vertical scroll
 *  - Hairline left/right arrows for next/prev when there’s a list
 */
export function FilePreviewModal() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const panelMode = useFilesStore((s) => s.panelMode);
  const goBackToBrowser = useFilesStore((s) => s.goBackToBrowser);
  const nextFile = useFilesStore((s) => s.nextFile);
  const prevFile = useFilesStore((s) => s.prevFile);
  const filePathList = useFilesStore((s) => s.filePathList);
  const currentFileIndex = useFilesStore((s) => s.currentFileIndex);
  const projectCtx = useProjectContext();
  // Sit above whatever dialog depth we're rendered inside (e.g. the Customize
  // overlay) so the preview never opens *behind* its host modal.
  const dialogDepth = useDialogDepth();

  const isOpen = panelMode === 'viewer' && !!selectedFilePath;

  const fileName = selectedFilePath?.split('/').pop() || '';
  const hasNext = currentFileIndex < filePathList.length - 1;
  const hasPrev = currentFileIndex > 0;

  const [historyPath, setHistoryPath] = useState<string | null>(null);
  // Markdown view toggle — default to rendered preview, allow switching to source.
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const isMarkdownFile = getLanguageFromExt(fileName) === 'markdown';

  useEffect(() => {
    setHistoryPath(null);
    setMarkdownPreview(true);
  }, [selectedFilePath]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        // Capture-phase + stopImmediatePropagation so ESC only closes the
        // preview — not a host Radix dialog underneath (e.g. the Customize
        // overlay), which would otherwise also fire its own escape handler.
        e.preventDefault();
        e.stopImmediatePropagation();
        if (historyPath) setHistoryPath(null);
        else goBackToBrowser();
        return;
      }
      if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        nextFile();
        return;
      }
      if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        prevFile();
        return;
      }
    };
    // Capture phase so we run before Radix's document-level escape listener.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, goBackToBrowser, nextFile, prevFile, hasNext, hasPrev, historyPath]);

  // Lock body scroll
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen]);

  const handleDownload = useCallback(async () => {
    if (!selectedFilePath || !projectCtx) return;
    try {
      await downloadFile(projectCtx.projectId, projectCtx.ref, selectedFilePath, fileName);
      toast.success(`Downloaded ${fileName}`);
    } catch {
      toast.error(`Failed to download ${fileName}`);
    }
  }, [selectedFilePath, fileName, projectCtx]);

  const handleHistory = useCallback(() => {
    setHistoryPath((p) => (p ? null : selectedFilePath));
  }, [selectedFilePath]);

  if (!isOpen) return null;
  // Portal to <body>: this full-screen fixed overlay is rendered inside
  // constrained containers (session side panel / Customize section) whose
  // overflow-hidden + occasional display:none would clip or collapse it.
  // Portaling escapes those subtrees; React context is preserved.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in-0 duration-150"
        style={{ zIndex: dialogOverlayZ(dialogDepth + 1) }}
        onClick={goBackToBrowser}
      />

      {/* Modal surface — `kx-fullscreen-modal` drops the top edge below the
          desktop title-bar inset so it clears the macOS traffic lights. */}
      <div
        className="kx-fullscreen-modal fixed inset-3 sm:inset-4 flex flex-col rounded-2xl border border-border/60 bg-background shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-[0.98] duration-150"
        style={{ zIndex: dialogContentZ(dialogDepth + 1) }}
      >
        {/* Top bar */}
        <div className="flex items-center gap-2 px-3 h-12 border-b border-border/40 shrink-0 bg-background/95 backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={goBackToBrowser}
            title="Back"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <div className="flex items-center gap-2 min-w-0 flex-1">
            {getFileIcon(fileName, {
              className: 'h-4 w-4 shrink-0 text-muted-foreground',
              variant: 'monochrome',
            })}
            <span className="text-sm font-medium truncate" title={selectedFilePath ?? ''}>
              {fileName}
            </span>
            {filePathList.length > 1 && (
              <span className="text-xs text-muted-foreground/70 tabular-nums shrink-0 ml-1">
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
                  'h-8 w-8 transition-colors',
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
                'h-8 w-8 transition-colors',
                historyPath ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={handleHistory}
              title={tHardcodedUi.raw('featuresProjectFilesComponentsFilePreviewModal.line179JsxAttrTitleCheckpointHistory')}
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
            <div className="w-px h-5 bg-border/50 mx-1" />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={goBackToBrowser}
              title={tHardcodedUi.raw('featuresProjectFilesComponentsFilePreviewModal.line198JsxAttrTitleCloseEsc')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 relative min-h-0 overflow-hidden">
          {/* Prev arrow */}
          {hasPrev && (
            <button
              onClick={prevFile}
              className={cn(
                'absolute left-3 top-1/2 -translate-y-1/2 z-20',
                'h-9 w-9 rounded-full bg-background/95 backdrop-blur border border-border/60',
                'shadow-sm hover:bg-background flex items-center justify-center transition-all',
                'opacity-70 hover:opacity-100',
              )}
              title={tHardcodedUi.raw('featuresProjectFilesComponentsFilePreviewModal.line217JsxAttrTitlePreviousFile')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}

          {/* Next arrow */}
          {hasNext && (
            <button
              onClick={nextFile}
              className={cn(
                'absolute right-3 top-1/2 -translate-y-1/2 z-20',
                'h-9 w-9 rounded-full bg-background/95 backdrop-blur border border-border/60',
                'shadow-sm hover:bg-background flex items-center justify-center transition-all',
                'opacity-70 hover:opacity-100',
              )}
              title={tHardcodedUi.raw('featuresProjectFilesComponentsFilePreviewModal.line233JsxAttrTitleNextFile')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}

          <div className="h-full w-full">
            <FileContentRenderer
              filePath={selectedFilePath}
              showHeader={false}
              readOnly
              markdownPreview={markdownPreview}
              onMarkdownPreviewChange={setMarkdownPreview}
            />
          </div>

          {/* History popover */}
          {historyPath && (
            <div className="absolute bottom-4 right-4 z-30 bg-popover border border-border/60 rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 fade-in-0 duration-150">
              <FileHistoryPopoverContent
                filePath={historyPath}
                onClose={() => setHistoryPath(null)}
              />
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
