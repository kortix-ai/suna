'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { DocxViewerPreview } from './docx-viewer';

/**
 * Normalize a display file name for the DOCX viewer. react-docx's
 * `importDocxFile` rejects any `File` whose name does not match `/\.docx?$/i`,
 * so the blob-backed path (which has no real file name) must supply one with a
 * valid extension. Returns the name unchanged when it already ends in
 * `.doc`/`.docx`, appends `.docx` to a bare name, and falls back to
 * `document.docx` when the name is absent or blank.
 */
export function ensureDocxFileName(fileName?: string): string {
  const trimmed = fileName?.trim();
  if (!trimmed) return 'document.docx';
  if (/\.docx?$/i.test(trimmed)) return trimmed;
  return `${trimmed}.docx`;
}

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
  /**
   * Original file name. Required for the blob-backed path so the viewer can
   * satisfy react-docx's `.docx`/`.doc` extension check (the object URL has no
   * usable name). Falls back to `document.docx` when omitted.
   */
  fileName?: string;
  className?: string;
  compact?: boolean;
}

export function DocxRenderer({ url, blob, fileName, className, compact = false }: DocxRendererProps) {
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
      fileName={ensureDocxFileName(fileName)}
      isDark={resolvedTheme === 'dark'}
      onIsDarkChange={() => {}}
      showToolbar={!compact}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
