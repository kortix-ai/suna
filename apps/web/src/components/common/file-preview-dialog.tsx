'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { FileContentRenderer } from '@/features/files/components/file-content-renderer';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { FileX, Maximize as Maximize2, Minimize as Minimize2 } from '@mynaui/icons-react';
import { useCallback, useEffect, useState } from 'react';

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
          'flex flex-col gap-0 overflow-hidden p-0 transition-colors duration-200',
          isFullscreen
            ? 'h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] sm:max-w-[calc(100vw-2rem)]'
            : 'h-[80vh] max-h-[80vh] sm:max-w-4xl',
        )}
      >
        <VisuallyHidden>
          <DialogTitle>
            {tHardcodedUi.raw('componentsCommonFilePreviewDialog.line89JsxTextFilePreview')}
            {fileName}
          </DialogTitle>
        </VisuallyHidden>

        {/* Header bar */}
        <div className="bg-muted/30 flex flex-shrink-0 items-center justify-between border-b px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-foreground truncate text-sm font-medium">{fileName}</span>
            <span className="text-muted-foreground hidden truncate text-xs sm:block">
              {filePath}
            </span>
          </div>

          <div className="ml-2 flex flex-shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-7 w-7"
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
              className="text-muted-foreground hover:text-foreground h-7 w-7"
              onClick={() => handleOpenChange(false)}
              title="Close"
            >
              <span className="text-lg leading-none">
                {tHardcodedUi.raw('componentsCommonFilePreviewDialog.line133JsxTextTimes')}
              </span>
            </Button>
          </div>
        </div>

        {/* File content */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <FileContentRenderer
            filePath={filePath}
            showHeader={false}
            readOnly
            className="h-full"
            errorFallback={(error, path) => {
              const isNotFound =
                error.includes('404') ||
                error.toLowerCase().includes('not found') ||
                error.toLowerCase().includes('no such file');
              return (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                  {isNotFound ? (
                    <>
                      <FileX className="text-muted-foreground/30 h-8 w-8" />
                      <p className="text-muted-foreground text-sm">
                        {tHardcodedUi.raw(
                          'componentsCommonFilePreviewDialog.line153JsxTextFileDoesNotExist',
                        )}
                      </p>
                      <p className="text-muted-foreground/60 max-w-sm font-mono text-xs break-all">
                        {path}
                      </p>
                      <p className="text-muted-foreground/40 mt-1 text-xs">
                        {tHardcodedUi.raw(
                          'componentsCommonFilePreviewDialog.line159JsxTextThisPathMayBeRelativeOrFromA',
                        )}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-muted-foreground text-sm">
                        {tHardcodedUi.raw(
                          'componentsCommonFilePreviewDialog.line165JsxTextCannotPreview',
                        )}
                        <span className="text-foreground font-mono">{path}</span>
                      </p>
                      <p className="text-muted-foreground/60 text-xs">{error}</p>
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
