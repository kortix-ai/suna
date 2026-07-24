'use client';

import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { FileSpreadsheet, RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useState } from 'react';
import { XlsxViewerPreview } from './xlsx-viewer';

export function isBlobUrl(path: string): boolean {
  return path.startsWith('blob:');
}

interface XlsxRendererProps {
  content?: string | null;
  filePath?: string;
  fileName: string;
  /** Extra controls for the viewer's own toolbar, rendered after zoom and
   *  before the file menu. */
  toolbarActions?: React.ReactNode;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
      sandbox_url?: string;
    };
  };
  onDownload?: () => void;
  isDownloading?: boolean;
}

export function XlsxRenderer({ filePath, fileName, className, toolbarActions }: XlsxRendererProps) {
  const { resolvedTheme } = useTheme();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const xlsxPath = filePath || fileName;

  useEffect(() => {
    if (!xlsxPath) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    setSrc(null);
    setError(null);

    (async () => {
      try {
        if (isBlobUrl(xlsxPath)) {
          if (!cancelled) setSrc(xlsxPath);
          return;
        }
        const { readFileAsBlob } = await import('@/features/files/api/opencode-files');
        const blob = await readFileAsBlob(xlsxPath);
        if (cancelled) return;
        if (!blob || blob.size === 0) throw new Error('Empty file received');
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch (e) {
        console.error('[XlsxRenderer] Error:', e);
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load spreadsheet');
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [xlsxPath, attempt]);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);

  if (error) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="space-y-3 text-center">
          <div className="bg-muted mx-auto flex h-16 w-16 items-center justify-center rounded-full">
            <FileSpreadsheet className="text-muted-foreground h-8 w-8" />
          </div>
          <div>
            <h3 className="text-foreground text-lg font-medium">Failed to load spreadsheet</h3>
            <p className="text-muted-foreground mt-1 text-xs">{error}</p>
          </div>
          <Button onClick={handleRetry} variant="outline" size="sm">
            <RefreshCw className="mr-2 h-3 w-3" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!src) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  return (
    <XlsxViewerPreview
      src={src}
      fileName={fileName}
      isDark={resolvedTheme === 'dark'}
      onIsDarkChange={() => {}}
      showUpload={false}
      className={cn('h-full w-full', className)}
      toolbarActions={toolbarActions}
    />
  );
}
