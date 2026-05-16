'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  X,
  Download,
  ChevronLeft,
  ChevronRight,
  History,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilesStore } from '../store/files-store';
import { FileContentRenderer } from './file-content-renderer';
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
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const panelMode = useFilesStore((s) => s.panelMode);
  const goBackToBrowser = useFilesStore((s) => s.goBackToBrowser);
  const nextFile = useFilesStore((s) => s.nextFile);
  const prevFile = useFilesStore((s) => s.prevFile);
  const filePathList = useFilesStore((s) => s.filePathList);
  const currentFileIndex = useFilesStore((s) => s.currentFileIndex);
  const projectCtx = useProjectContext();

  const isOpen = panelMode === 'viewer' && !!selectedFilePath;

  const fileName = selectedFilePath?.split('/').pop() || '';
  const hasNext = currentFileIndex < filePathList.length - 1;
  const hasPrev = currentFileIndex > 0;

  const [historyPath, setHistoryPath] = useState<string | null>(null);

  useEffect(() => {
    setHistoryPath(null);
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
        e.preventDefault();
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
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm animate-in fade-in-0 duration-150"
        onClick={goBackToBrowser}
      />

      {/* Modal surface */}
      <div className="fixed inset-3 sm:inset-4 z-50 flex flex-col rounded-2xl border border-border/60 bg-background shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-[0.98] duration-150">
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
              <span className="text-[11px] text-muted-foreground/70 tabular-nums shrink-0 ml-1">
                {currentFileIndex + 1} / {filePathList.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8 transition-colors',
                historyPath ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={handleHistory}
              title="Checkpoint history"
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
              title="Close (Esc)"
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
              title="Previous file (←)"
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
              title="Next file (→)"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}

          <div className="h-full w-full">
            <FileContentRenderer filePath={selectedFilePath} showHeader={false} readOnly />
          </div>

          {/* History popover */}
          {historyPath && (
            <div className="absolute bottom-4 right-4 z-30 bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 fade-in-0 duration-150">
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
