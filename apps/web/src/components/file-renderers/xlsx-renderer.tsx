'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { XlsxViewerPreview } from '@/components/ui/extend/xlsx-viewer';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { useViewerDarkMode } from './viewer-theme';

interface XlsxRendererProps {
  /** Workspace path (loaded via the files API) or a blob: URL. */
  filePath?: string;
  fileName: string;
  className?: string;
}

export function XlsxRenderer({ filePath, fileName, className }: XlsxRendererProps) {
  const [isDark, setIsDark] = useViewerDarkMode();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setError(null);

    (async () => {
      let workbookBlob: Blob;
      if (filePath.startsWith('blob:')) {
        const resp = await fetch(filePath);
        if (!resp.ok) throw new Error(`Failed to fetch workbook (${resp.status})`);
        workbookBlob = await resp.blob();
      } else {
        const { readFileAsBlob } = await import('@/features/files/api/runtime-files');
        workbookBlob = await readFileAsBlob(filePath);
      }
      if (cancelled) return;
      objectUrl = URL.createObjectURL(workbookBlob);
      setSrc(objectUrl);
    })().catch((err: unknown) => {
      console.error('[XlsxRenderer] Error loading workbook:', err);
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Failed to load workbook');
      }
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath]);

  if (error) {
    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center', className)}>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">{error}</p>
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
      isDark={isDark}
      onIsDarkChange={setIsDark}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
