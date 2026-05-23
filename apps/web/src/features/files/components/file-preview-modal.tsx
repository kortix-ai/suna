'use client';

import { useTranslations } from 'next-intl';

import { useCallback, useEffect, useState } from 'react';
import {
  X,
  Download,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  History,
  Code,
  Eye,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilesStore } from '../store/files-store';
import { FileContentRenderer, getLanguageFromExt } from './file-content-renderer';
import { FileHistoryPopoverContent } from './file-history-popover';
import { getFileIcon } from './file-icon';
import { downloadFile } from '../api/opencode-files';
import { openTabAndNavigate } from '@/stores/tab-store';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

/**
 * Full-screen file preview modal with blurred backdrop.
 * History opens as a floating popover inside the modal.
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

  const isOpen = panelMode === 'viewer' && !!selectedFilePath;

  const fileName = selectedFilePath?.split('/').pop() || '';
  const hasNext = currentFileIndex < filePathList.length - 1;
  const hasPrev = currentFileIndex > 0;

  // Local history popover
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  // Markdown view toggle — default to rendered preview, allow switching to source.
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const isMarkdownFile = getLanguageFromExt(fileName) === 'markdown';

  // Close history and reset preview when file changes
  useEffect(() => {
    setHistoryPath(null);
    setMarkdownPreview(true);
  }, [selectedFilePath]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (historyPath) {
          setHistoryPath(null);
        } else {
          goBackToBrowser();
        }
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

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, goBackToBrowser, nextFile, prevFile, hasNext, hasPrev, historyPath]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isOpen]);

  const handleDownload = useCallback(async () => {
    if (!selectedFilePath) return;
    try {
      await downloadFile(selectedFilePath, fileName);
      toast.success(`Downloaded ${fileName}`);
    } catch {
      toast.error(`Failed to download ${fileName}`);
    }
  }, [selectedFilePath, fileName]);

  const handleOpenInTab = useCallback(() => {
    if (!selectedFilePath) return;
    openTabAndNavigate({
      id: `file:${selectedFilePath}`,
      title: fileName,
      type: 'file',
      href: `/files/${encodeURIComponent(selectedFilePath)}`,
    });
    goBackToBrowser();
  }, [selectedFilePath, fileName, goBackToBrowser]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop - blurred overlay */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md animate-in fade-in-0 duration-200"
        onClick={goBackToBrowser}
      />

      {/* Modal container */}
      <div className="fixed inset-0 z-50 flex flex-col pointer-events-none animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Top bar - floating. `kx-titlebar-safe-mt` keeps it below the
            desktop title-bar inset so it clears the macOS traffic lights. */}
        <div className="kx-titlebar-safe-mt pointer-events-auto mx-auto flex items-center justify-between gap-4 px-4 h-12 bg-background/90 backdrop-blur-xl border border-border/50 rounded-2xl shadow-lg max-w-3xl w-[calc(100%-2rem)]">
          {/* Left: back + file info */}
          <div className="flex items-center gap-2.5 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={goBackToBrowser}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2 min-w-0">
              {getFileIcon(fileName, { className: 'h-4 w-4 shrink-0', variant: 'monochrome' })}
              <span className="text-sm font-medium truncate max-w-[300px]">{fileName}</span>
            </div>
            {filePathList.length > 1 && (
              <span className="text-xs text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-full shrink-0 tabular-nums">
                {currentFileIndex + 1} / {filePathList.length}
              </span>
            )}
          </div>

          {/* Right: actions */}
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
              title="History"
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
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={handleOpenInTab}
              title={tHardcodedUi.raw('featuresFilesComponentsFilePreviewModal.line198JsxAttrTitleOpenInTab')}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <div className="w-px h-5 bg-border/50 mx-1" />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={goBackToBrowser}
              title={tHardcodedUi.raw('featuresFilesComponentsFilePreviewModal.line208JsxAttrTitleCloseEsc')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Content area with navigation arrows */}
        <div className="flex-1 relative overflow-hidden my-3 mx-3 pointer-events-auto">
          {/* Prev arrow */}
          {hasPrev && (
            <button
              onClick={prevFile}
              className="absolute left-3 top-1/2 -translate-y-1/2 z-20 h-10 w-10 rounded-full bg-background/80 backdrop-blur-sm border border-border/50 shadow-md hover:bg-background flex items-center justify-center transition-colors cursor-pointer hover:scale-105"
              title={tHardcodedUi.raw('featuresFilesComponentsFilePreviewModal.line222JsxAttrTitlePreviousFile')}
            >
              <ChevronLeft className="h-5 w-5 text-foreground" />
            </button>
          )}

          {/* Next arrow */}
          {hasNext && (
            <button
              onClick={nextFile}
              className="absolute right-3 top-1/2 -translate-y-1/2 z-20 h-10 w-10 rounded-full bg-background/80 backdrop-blur-sm border border-border/50 shadow-md hover:bg-background flex items-center justify-center transition-colors cursor-pointer hover:scale-105"
              title={tHardcodedUi.raw('featuresFilesComponentsFilePreviewModal.line233JsxAttrTitleNextFile')}
            >
              <ChevronRight className="h-5 w-5 text-foreground" />
            </button>
          )}

          {/* File renderer in a card */}
          <div className="h-full bg-background rounded-2xl border border-border/50 shadow-xl overflow-hidden">
            <FileContentRenderer
              filePath={selectedFilePath}
              showHeader={false}
              readOnly
              markdownPreview={markdownPreview}
              onMarkdownPreviewChange={setMarkdownPreview}
            />
          </div>

          {/* History popover - floating inside modal */}
          {historyPath && (
            <div className="absolute bottom-4 right-4 z-30 bg-popover border border-border rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
              <FileHistoryPopoverContent
                filePath={historyPath}
                onClose={() => setHistoryPath(null)}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
