'use client';

import { useTranslations } from 'next-intl';

import { useCallback, useEffect, useState } from 'react';
import { FileX, Maximize2, Minimize2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { FileContentRenderer } from '@/features/files/components/file-content-renderer';
import { useOcFileOpen } from '@/components/session/use-oc-file-open';

/**
 * Global file preview dialog.
 *
 * Renders as a modal overlay so the user stays on their current page.
 * Provides:
 *   - Full file preview via FileContentRenderer (handles all file types)
 *   - Fullscreen toggle
 *   - Click outside / X / Escape to close
 */
export function FilePreviewDialog() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const rawFilePath = useFilePreviewStore((s) => s.filePath);
  const closePreview = useFilePreviewStore((s) => s.closePreview);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Resolve absolute paths to project-relative paths for FileContentRenderer
  const { toDisplayPath } = useOcFileOpen();
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!rawFilePath) {
      setResolvedPath(null);
      return;
    }
    // toDisplayPath is synchronous and converts abs → relative using cached prefixes
    const resolved = toDisplayPath(rawFilePath);
    setResolvedPath(resolved);
  }, [rawFilePath, toDisplayPath]);

  const filePath = resolvedPath || rawFilePath;
  const fileName = filePath?.split('/').pop() || '';

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setIsFullscreen(false);
        closePreview();
      }
    },
    [closePreview],
  );

  if (!isOpen || !filePath) return null;

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogContent
        hideCloseButton
        className={cn(
          'flex flex-col p-0 gap-0 overflow-hidden transition-colors duration-200',
          isFullscreen
            ? 'sm:max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] h-[calc(100vh-2rem)]'
            : 'sm:max-w-4xl max-h-[80vh] h-[80vh]',
        )}
      >
        <VisuallyHidden>
          <DialogTitle>{tHardcodedUi.raw('componentsCommonFilePreviewDialog.line89JsxTextFilePreview')}{fileName}</DialogTitle>
        </VisuallyHidden>

        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground truncate">
              {fileName}
            </span>
            <span className="text-xs text-muted-foreground truncate hidden sm:block">
              {filePath}
            </span>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setIsFullscreen((v) => !v)}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => handleOpenChange(false)}
              title="Close"
            >
              <span className="text-lg leading-none">{tHardcodedUi.raw('componentsCommonFilePreviewDialog.line133JsxTextTimes')}</span>
            </Button>
          </div>
        </div>

        {/* File content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileContentRenderer
            filePath={filePath}
            showHeader={false}
            readOnly
            className="h-full"
            errorFallback={(error, path) => {
              const isNotFound = error.includes('404') || error.toLowerCase().includes('not found') || error.toLowerCase().includes('no such file');
              return (
                <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
                  {isNotFound ? (
                    <>
                      <FileX className="h-8 w-8 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsCommonFilePreviewDialog.line153JsxTextFileDoesNotExist')}</p>
                      <p className="text-xs font-mono text-muted-foreground/60 max-w-sm break-all">
                        {path}
                      </p>
                      <p className="text-xs text-muted-foreground/40 mt-1">{tHardcodedUi.raw('componentsCommonFilePreviewDialog.line159JsxTextThisPathMayBeRelativeOrFromA')}</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsCommonFilePreviewDialog.line165JsxTextCannotPreview')}<span className="font-mono text-foreground">{path}</span>
                      </p>
                      <p className="text-xs text-muted-foreground/60">{error}</p>
                    </>
                  )}
                </div>
              );
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
