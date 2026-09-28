'use client';

import { cn } from '@/lib/utils';
import { getDirectory, getFilename } from '@/ui';
import type { GrepFileGroup } from '@kortix/shared/tool-output';
import { CaretRightIcon as ChevronRight, FileTextIcon as FileText } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';

export function parseFilePaths(output: string): string[] | null {
  if (!output) return null;
  const lines = output
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const pathLike = lines.filter(
    (l) => l.startsWith('/') || l.startsWith('./') || l.startsWith('~'),
  );
  if (pathLike.length >= lines.length * 0.7) return pathLike;
  return null;
}

export { type GrepFileGroup, parseGrepOutput } from '@kortix/shared/tool-output';

export function ToolListRow({
  icon,
  name,
  dir,
  trailing,
  chevron,
  onClick,
  onNameClick,
  disabled = false,
  title,
}: {
  icon: ReactNode;
  name: string;
  dir?: string;
  trailing?: ReactNode;
  chevron?: 'collapsed' | 'expanded';

  onClick?: () => void;

  onNameClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div
      className={cn(
        // Same row grammar as WebSourceRow: leading glyph, the name taking the
        // free space, and the secondary detail parked on the right. A file list
        // and a source list are the same shape of thing — a set of results the
        // tool found — so they should not read as two different components.
        'group flex items-center gap-2.5 rounded-sm px-2 py-2 transition-colors duration-150',
        disabled
          ? 'cursor-default opacity-70'
          : onClick
            ? 'hover:bg-muted cursor-pointer'
            : undefined,
      )}
      onClick={onClick && !disabled ? onClick : undefined}
      title={title}
    >
      {chevron && (
        <ChevronRight
          className={cn(
            'text-muted-foreground/60 size-3.5 shrink-0 transition-transform',
            chevron === 'expanded' && 'rotate-90',
          )}
        />
      )}
      <span className="text-muted-foreground/60 group-hover:text-foreground/70 shrink-0 transition-colors [&>svg]:size-4">
        {icon}
      </span>
      <span
        className={cn(
          'text-foreground min-w-0 flex-1 truncate font-mono text-sm',
          onNameClick && !disabled && 'hover:text-primary cursor-pointer transition-colors',
        )}
        onClick={
          onNameClick && !disabled
            ? (e) => {
                e.stopPropagation();
                onNameClick();
              }
            : undefined
        }
      >
        {name}
      </span>
      {dir && (
        <span className="text-muted-foreground max-w-[40%] shrink-0 truncate font-mono text-sm">
          {dir}
        </span>
      )}
      {trailing !== undefined && trailing !== null && (
        <span className="text-muted-foreground shrink-0 text-sm tabular-nums">{trailing}</span>
      )}
    </div>
  );
}

export function InlineFileList({
  paths,
  onFileClick,
  toDisplayPath,
  disabled = false,
}: {
  paths: string[];
  onFileClick: (path: string) => void;
  toDisplayPath: (p: string) => string;
  disabled?: boolean;
}) {
  return (
    <div>
      {paths.map((fp) => {
        const dp = toDisplayPath(fp);
        return (
          <ToolListRow
            key={fp}
            icon={<FileText />}
            name={getFilename(dp) ?? dp}
            dir={getDirectory(dp)}
            title={dp}
            disabled={disabled}
            onClick={() => onFileClick(fp)}
          />
        );
      })}
    </div>
  );
}

export function InlineGrepResults({
  groups,
  onFileClick,
  toDisplayPath,
  disabled = false,
}: {
  groups: GrepFileGroup[];
  onFileClick: (path: string) => void;
  toDisplayPath: (p: string) => string;
  disabled?: boolean;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(groups.length === 1 ? 0 : null);

  return (
    <div>
      {groups.map((group, i) => {
        const dp = toDisplayPath(group.filePath);
        const isExpanded = expandedIndex === i;

        return (
          <div key={group.filePath}>
            <ToolListRow
              icon={<FileText />}
              name={getFilename(dp) ?? dp}
              dir={getDirectory(dp)}
              title={group.filePath}
              chevron={isExpanded ? 'expanded' : 'collapsed'}
              trailing={group.matches.length}
              onClick={() => setExpandedIndex(isExpanded ? null : i)}
              onNameClick={disabled ? undefined : () => onFileClick(group.filePath)}
              disabled={disabled}
            />
            {isExpanded && (
              <div className="border-border/20 bg-muted/10 border-t">
                {group.matches.map((match, j) => (
                  <div
                    key={j}
                    className="border-border/10 flex items-start gap-0 border-b last:border-b-0"
                  >
                    <span className="text-muted-foreground/50 w-10 shrink-0 py-1 pr-2 text-right font-mono text-xs select-none">
                      {match.line}
                    </span>
                    <span className="text-foreground/70 py-1 pr-2 font-mono text-xs leading-relaxed break-all">
                      {match.content}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
