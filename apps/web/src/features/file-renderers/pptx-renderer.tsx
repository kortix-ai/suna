'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { downloadFile } from '@/features/files/api/opencode-files';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';
import { Download, Presentation } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';

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
  const displayName = fileName.split('/').pop() ?? fileName;

  return (
    <EmptyState
      className={cn('h-full w-full', className)}
      icon={Presentation}
      size="sm"
      title={displayName}
      action={
        <Button
          // variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={busy}
        >
          {busy ? <Loading className="shrink-0" /> : <Download className="shrink-0" />}
          {tHardcodedUi.raw('componentsFileRenderersPptxRenderer.line212JsxTextDownloadToView')}
        </Button>
      }
    />
  );
}
