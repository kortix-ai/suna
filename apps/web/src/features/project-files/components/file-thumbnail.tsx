'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';
import { FileContentRenderer, getFileCategory } from './file-content-renderer';

interface FileThumbnailProps {
  filePath: string;
  fileName: string;
  className?: string;
}

const THUMB_SCALE = 0.28;
const VIRTUAL_PCT = `${100 / THUMB_SCALE}%`;

export function FileThumbnail({ filePath, fileName, className }: FileThumbnailProps) {
  const isImage = getFileCategory(fileName) === 'image';
  const extLower = fileName.split('.').pop()?.toLowerCase() || '';
  const ext = fileName.includes('.') ? extLower.toUpperCase() : '';
  const extChalk = ext ? chalkColors(ext) : null;

  return (
    <div className={cn('bg-popover relative overflow-hidden rounded-md', className)}>
      <div
        className="pointer-events-none absolute top-0 left-0 origin-top-left select-none [&_*]:!cursor-default"
        style={
          isImage
            ? { width: '100%', height: '100%' }
            : {
                transform: `scale(${THUMB_SCALE})`,
                width: VIRTUAL_PCT,
                height: VIRTUAL_PCT,
              }
        }
        aria-hidden
      >
        <FileContentRenderer filePath={filePath} readOnly showHeader={false} />
      </div>
      {ext && !isImage && extChalk && (
        <Badge
          variant="transparent"
          size="xs"
          className="absolute right-2 bottom-2 z-10 border font-semibold tracking-wider uppercase backdrop-blur-sm"
          style={{
            backgroundColor: extChalk.background,
            color: extChalk.foreground,
            borderColor: extChalk.border,
          }}
        >
          {ext}
        </Badge>
      )}
    </div>
  );
}
