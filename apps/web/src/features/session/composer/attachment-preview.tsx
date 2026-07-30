'use client';

import { useEffect, useState } from 'react';

import { getFileIcon } from '@/features/project-files';
import { cn } from '@/lib/utils';
import { XIcon as X } from '@phosphor-icons/react';

import type { AttachedFile } from './types';

// ============================================================================
// Attachment Preview Strip — grid-style file cards
// ============================================================================

/** Thumbnail for a locally attached file (not yet uploaded). */
function AttachmentThumbnail({ af, name }: { af: AttachedFile; name: string }) {
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // Check if this is an image — be generous with detection
  const isImg =
    af.isImage ||
    (af.kind === 'local' && af.file.type.startsWith('image/')) ||
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'avif'].includes(
      ext,
    );

  // HEIC: convert to JPEG for preview (browsers can't render HEIC natively)
  const isHeic = ext === 'heic' || ext === 'heif';
  const [heicUrl, setHeicUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isHeic || !isImg || af.kind !== 'local') return;
    let cancelled = false;
    let u: string | null = null;
    import('@/lib/utils/heic-convert')
      .then(({ convertHeicBlobToJpeg }) =>
        convertHeicBlobToJpeg(af.file).then((jpeg) => {
          if (cancelled) return;
          u = URL.createObjectURL(jpeg);
          setHeicUrl(u);
        }),
      )
      .catch(() => {});
    return () => {
      cancelled = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [af, isHeic, isImg]);

  // For local text/code files, read first ~12 lines for preview
  useEffect(() => {
    if (af.kind !== 'local' || isImg) return;
    const textExts = [
      'js',
      'jsx',
      'ts',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'c',
      'cpp',
      'h',
      'hpp',
      'css',
      'scss',
      'html',
      'vue',
      'svelte',
      'json',
      'yaml',
      'yml',
      'toml',
      'xml',
      'md',
      'mdx',
      'txt',
      'log',
      'sh',
      'bash',
      'zsh',
      'sql',
      'swift',
      'kt',
      'scala',
      'lua',
      'r',
      'php',
      'pl',
      'ini',
      'conf',
      'env',
      'gitignore',
      'dockerfile',
    ];
    if (!textExts.includes(ext)) return;
    const reader = new FileReader();
    reader.onload = () =>
      setTextPreview((reader.result as string).split('\n').slice(0, 12).join('\n'));
    reader.readAsText(af.file.slice(0, 2048));
  }, [af, ext, isImg]);

  // Image thumbnail — HEIC uses converted URL, everything else uses original
  if (isImg) {
    const src = isHeic ? heicUrl : af.kind === 'local' ? af.localUrl : af.url;
    if (!src) return null; // HEIC still converting — show nothing briefly
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
    );
  }

  // Text/code thumbnail
  if (textPreview) {
    return (
      <div className="absolute inset-0 overflow-hidden p-1">
        <pre className="text-muted-foreground/70 pointer-events-none m-0 overflow-hidden p-0 font-mono text-xs leading-[1.4] whitespace-pre select-none">
          {textPreview}
        </pre>
        <div className="from-muted/20 absolute right-0 bottom-0 left-0 h-6 bg-gradient-to-t to-transparent" />
      </div>
    );
  }

  // Fallback: large icon
  return getFileIcon(name, { className: 'h-10 w-10', variant: 'monochrome' });
}

export function AttachmentPreview({
  files,
  onRemove,
}: {
  files: AttachedFile[];
  onRemove: (index: number) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {files.map((af, i) => {
        const name = af.kind === 'local' ? af.file.name : af.filename;
        const ext = name.split('.').pop()?.toLowerCase() || '';

        return (
          <div key={i} className="group relative">
            <div
              className={cn(
                'border-border/50 flex flex-col overflow-hidden rounded-2xl border',
                'w-[120px] cursor-default select-none',
                'bg-card hover:bg-muted/30 hover:border-border transition-colors duration-150',
              )}
            >
              {/* Thumbnail area */}
              <div className="bg-muted/20 relative flex h-[80px] items-center justify-center overflow-hidden">
                <AttachmentThumbnail af={af} name={name} />
                {/* Extension badge */}
                {ext && !af.isImage && (
                  <span className="text-muted-foreground/50 bg-background/80 absolute right-1 bottom-1 z-[5] rounded px-1 py-0.5 text-xs font-medium tracking-wider uppercase">
                    {ext.toUpperCase()}
                  </span>
                )}
              </div>
              {/* Name bar */}
              <div className="border-border/30 flex h-[32px] items-center border-t px-2 py-1.5">
                <div className="flex w-full min-w-0 items-center gap-1">
                  {getFileIcon(name, { className: 'h-3.5 w-3.5 shrink-0', variant: 'monochrome' })}
                  <span className="text-foreground truncate text-xs">{name}</span>
                </div>
              </div>
            </div>
            {/* Remove button */}
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="border-card absolute -top-1.5 -right-1.5 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border-2 bg-black text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-white dark:text-black"
              aria-label={`Remove ${name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
