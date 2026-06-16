'use client';

import { useTranslations } from 'next-intl';

import React, { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Download, FileText } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { downloadFile } from '@/features/files/api/opencode-files';

interface PptxRendererProps {
  content?: string | null;
  binaryUrl?: string | null;
  blob?: Blob | null;
  filePath?: string;
  fileName: string;
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
  onFullScreen?: () => void;
}

/**
 * PptxRenderer — there is no reliable in-browser PowerPoint renderer, so we
 * present a clean download action rather than a half-working preview.
 */
export function PptxRenderer({
  blob,
  filePath,
  fileName,
  className,
  onDownload,
  isDownloading,
}: PptxRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (onDownload) {
      onDownload();
      return;
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (filePath) {
      setDownloading(true);
      try {
        await downloadFile(filePath, fileName);
      } finally {
        setDownloading(false);
      }
    }
  }, [onDownload, blob, filePath, fileName]);

  const busy = isDownloading || downloading;

  return (
    <div className={cn('w-full h-full flex items-center justify-center', className)}>
      <div className="text-center space-y-4 p-8">
        <div className="mx-auto w-16 h-16 rounded-xl bg-muted/50 flex items-center justify-center">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">{fileName}</p>
        <Button size="sm" onClick={handleDownload} disabled={busy}>
          {busy ? (
            <KortixLoader size="small" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}{tHardcodedUi.raw('componentsFileRenderersPptxRenderer.line212JsxTextDownloadToView')}</Button>
      </div>
    </div>
  );
}
