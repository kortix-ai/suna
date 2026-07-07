'use client';

import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { PDFViewer } from './pdf-viewer';

export function base64PdfContentToBlob(fileContent: string): Blob {
  const binaryString = atob(fileContent);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'application/pdf' });
}

interface PdfRendererProps {
  /** Base64 PDF content returned by /file/content. */
  fileContent?: string | null;
  /** Existing PDF object URL fallback. */
  url?: string | null;
  className?: string;
  compact?: boolean;
  fileName?: string;
}

export function PdfRenderer({
  fileContent,
  url,
  className,
  compact = false,
  fileName,
}: PdfRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!fileContent && !url) {
      setPdfUrl(null);
      setStatus('loading');
      return;
    }

    if (fileContent) {
      try {
        const blob = base64PdfContentToBlob(fileContent);
        const nextUrl = URL.createObjectURL(blob);
        setPdfUrl(nextUrl);
        setStatus('ready');
        return () => {
          URL.revokeObjectURL(nextUrl);
        };
      } catch (err) {
        console.error('[PdfRenderer] Error creating PDF URL:', err);
        setPdfUrl(null);
        setStatus('error');
      }
      return;
    }

    setPdfUrl(url ?? null);
    setStatus(url ? 'ready' : 'loading');
  }, [fileContent, url]);

  if (status === 'loading') {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  if (status === 'error' || !pdfUrl) {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center',
          className,
        )}
      >
        <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
          <AlertTriangle className="text-muted-foreground h-4 w-4" />
        </div>
        <div>
          <p className="text-foreground text-sm font-medium">
            {tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line277JsxTextFailedToLoadPdf')}
          </p>
          {!compact && (
            <p className="text-muted-foreground mt-1 text-xs">
              {tHardcodedUi.raw(
                'componentsFileRenderersPdfRenderer.line278JsxTextTheFileMayBeCorruptedOrInaccessible',
              )}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <PDFViewer
      src={pdfUrl}
      fileName={fileName}
      showToolbar={!compact}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
