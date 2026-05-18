'use client';

import { cn } from '@/lib/utils';
import { FileContentRenderer, getFileCategory } from './file-content-renderer';

interface FileThumbnailProps {
  filePath: string;
  fileName: string;
  className?: string;
}

/**
 * File preview thumbnail. Uses the SAME FileContentRenderer as the full file
 * viewer — UnifiedMarkdown for .md, CodeEditor for code, the same iframe/proxy
 * for HTML, etc. — so the preview and the opened file are rendered by the
 * identical components end-to-end. A uniform CSS scale shrinks the viewport
 * so the rendered output reads as a zoomed-out thumbnail.
 */

const THUMB_SCALE = 0.28;
const VIRTUAL_PCT = `${100 / THUMB_SCALE}%`;

export function FileThumbnail({ filePath, fileName, className }: FileThumbnailProps) {
  const isImage = getFileCategory(fileName) === 'image';
  const extLower = fileName.split('.').pop()?.toLowerCase() || '';
  const ext = fileName.includes('.') ? extLower.toUpperCase() : '';

  return (
    <div className={cn('relative overflow-hidden bg-muted/20', className)}>
      <div
        className="absolute top-0 left-0 origin-top-left pointer-events-none select-none [&_*]:!cursor-default"
        style={isImage ? { width: '100%', height: '100%' } : {
          transform: `scale(${THUMB_SCALE})`,
          width: VIRTUAL_PCT,
          height: VIRTUAL_PCT,
        }}
        aria-hidden
      >
        <FileContentRenderer filePath={filePath} readOnly showHeader={false} />
      </div>
      {ext && !isImage && (
        <span className="absolute bottom-1.5 right-1.5 text-[0.5625rem] font-medium text-muted-foreground/50 uppercase tracking-wider bg-background/80 px-1.5 py-0.5 rounded z-10">
          {ext}
        </span>
      )}
    </div>
  );
}
