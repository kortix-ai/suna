'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ChevronRight, FileIcon, FileText, Folder } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { useToolNavigation } from '@/features/session/tool/shared/infrastructure';
import { getDirectory, getFilename } from '@/ui';

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

interface GrepMatch {
  line: number;
  content: string;
}
export interface GrepFileGroup {
  filePath: string;
  matches: GrepMatch[];
}

export function parseGrepOutput(output: string): { matchCount: number; groups: GrepFileGroup[] } | null {
  if (!output) return null;
  const text = String(output).trim();
  const headerMatch = text.match(/^Found\s+(\d+)\s+match/i);
  const matchCount = headerMatch ? parseInt(headerMatch[1], 10) : 0;
  const body = headerMatch ? text.slice(headerMatch[0].length).trim() : text;
  if (!body) return null;

  const groups: GrepFileGroup[] = [];
  const blocks = body.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const fileMatch = trimmed.match(/^(\/[^:]+?):\s*/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1];
    const rest = trimmed.slice(fileMatch[0].length);
    const matches: GrepMatch[] = [];
    const lineRegex = /Line\s+(\d+):\s*([\s\S]*?)(?=\s*(?:Line\s+\d+:|$))/g;
    let m: RegExpExecArray | null;
    while ((m = lineRegex.exec(rest)) !== null) {
      matches.push({
        line: parseInt(m[1], 10),
        content: m[2].trim().replace(/;$/, ''),
      });
    }
    if (matches.length > 0) groups.push({ filePath, matches });
  }

  if (groups.length === 0) return null;
  return {
    matchCount: matchCount || groups.reduce((sum, g) => sum + g.matches.length, 0),
    groups,
  };
}

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
        'group flex items-center gap-1.5 px-3 py-1 transition-colors',
        disabled
          ? 'cursor-default opacity-70'
          : onClick
            ? 'hover:bg-muted/50 cursor-pointer'
            : undefined,
      )}
      onClick={onClick && !disabled ? onClick : undefined}
      title={title}
    >
      {chevron && (
        <ChevronRight
          className={cn(
            'text-muted-foreground size-3 flex-shrink-0 transition-transform',
            chevron === 'expanded' && 'rotate-90',
          )}
        />
      )}
      <span className="text-muted-foreground/50 group-hover:text-foreground/60 flex-shrink-0 transition-colors [&>svg]:size-3">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden text-xs">
        <span
          className={cn(
            'text-foreground flex-shrink-0 font-mono font-medium whitespace-nowrap',
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
        {dir && <span className="text-muted-foreground/40 truncate text-xs">{dir}</span>}
      </span>
      {trailing !== undefined && trailing !== null && (
        <span className="text-muted-foreground/50 flex-shrink-0 text-xs">{trailing}</span>
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
    <div className="py-0.5">
      {paths.map((fp, i) => {
        const dp = toDisplayPath(fp);
        return (
          <ToolListRow
            key={i}
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
    <div className="py-0.5">
      {groups.map((group, i) => {
        const dp = toDisplayPath(group.filePath);
        const isExpanded = expandedIndex === i;

        return (
          <div key={i}>
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
                    <span className="text-muted-foreground/50 w-10 flex-shrink-0 py-1 pr-2 text-right font-mono text-xs select-none">
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

