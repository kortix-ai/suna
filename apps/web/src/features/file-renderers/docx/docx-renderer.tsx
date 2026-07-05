'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { DocxViewerPreview } from './docx-viewer';

export function resolveDocxSource({
  url,
  blob,
  createObjectUrl,
}: {
  url?: string;
  blob?: Blob;
  createObjectUrl: (blob: Blob) => string;
}): { src: string | null; revocable: boolean } {
  if (blob) {
    return { src: createObjectUrl(blob), revocable: true };
  }
  return { src: url ?? null, revocable: false };
}

interface DocxRendererProps {
  url?: string;
  blob?: Blob;
  className?: string;
  compact?: boolean;
}

export function DocxRenderer({ url, blob, className, compact = false }: DocxRendererProps) {
  const { resolvedTheme } = useTheme();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const { src: nextSrc, revocable } = resolveDocxSource({
      url,
      blob,
      createObjectUrl: (b) => URL.createObjectURL(b),
    });
    setSrc(nextSrc);
    return () => {
      if (revocable && nextSrc) URL.revokeObjectURL(nextSrc);
    };
  }, [url, blob]);

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
      isDark={resolvedTheme === 'dark'}
      onIsDarkChange={() => {}}
      showToolbar={!compact}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
