'use client';

import { useEffect, useState } from 'react';
import { DocxViewerPreview } from '@/components/ui/extend/docx-viewer';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { useViewerDarkMode } from './viewer-theme';

interface DocxRendererProps {
  url?: string;
  blob?: Blob;
  fileName?: string;
  className?: string;
}

export function DocxRenderer({ url, blob, fileName, className }: DocxRendererProps) {
  const [isDark, setIsDark] = useViewerDarkMode();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setObjectUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(blob);
    setObjectUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [blob]);

  const src = blob ? objectUrl : url;
  // The viewer derives the document name from `src` when fileName is absent —
  // for extensionless blob: URLs that fails react-docx's format check.
  const effectiveFileName =
    fileName && /\.docx?$/i.test(fileName) ? fileName : (fileName ?? 'document') + '.docx';

  if (!src) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  return (
    <DocxViewerPreview
      src={src}
      fileName={effectiveFileName}
      isDark={isDark}
      onIsDarkChange={setIsDark}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
