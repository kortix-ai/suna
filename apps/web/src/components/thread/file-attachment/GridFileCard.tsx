'use client';

import { cn } from '@/lib/utils';
import { FileThumbnail } from '@/features/files/components/file-thumbnail';
import { getFileIcon } from '@/features/files/components/file-icon';

interface GridFileCardProps {
  filePath: string;
  fileName: string;
  onClick?: () => void;
  className?: string;
}

/**
 * Grid-style file card with thumbnail preview + filename.
 * This is the universal file card used everywhere in the app.
 * Matches the /files page grid view cards.
 */
export function GridFileCard({ filePath, fileName, onClick, className }: GridFileCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'group relative flex flex-col rounded-2xl border border-border/50 cursor-pointer select-none overflow-hidden',
        'transition-colors duration-150',
        'hover:bg-muted/30 hover:border-border hover:shadow-sm',
        'active:scale-[0.98]',
        'w-[150px]',
        className,
      )}
    >
      {/* Thumbnail area */}
      <FileThumbnail
        filePath={filePath}
        fileName={fileName}
        className="h-[100px]"
      />

      {/* Name area */}
      <div className="px-2.5 py-2 border-t border-border/30 h-[38px] flex items-center">
        <div className="flex items-center gap-1.5 min-w-0 w-full">
          {getFileIcon(fileName, { className: 'h-4 w-4 shrink-0', variant: 'monochrome' })}
          <span className="text-[13px] truncate text-foreground">{fileName}</span>
        </div>
      </div>
    </div>
  );
}
