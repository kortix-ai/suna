'use client';

import React, { useMemo, useState } from 'react';
import {
  Search,
  AlertCircle,
  FileText,
  FolderOpen,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { useOcFileOpen } from './useOcFileOpen';
import { formatTimestamp } from '../utils';
import {
  Counter,
  Status,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewShell,
} from '../shared/primitives';

function getFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
function getDirectory(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.substring(0, idx);
}

function parseFilePaths(output: string): string[] | null {
  if (!output) return null;
  const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const pathLike = lines.filter((l) => l.startsWith('/') || l.startsWith('./') || l.startsWith('~'));
  return pathLike.length >= lines.length * 0.7 ? pathLike : null;
}

interface GrepMatch { line: number; content: string; }
interface GrepFileGroup { filePath: string; matches: GrepMatch[]; }

function parseGrepOutput(output: string): { matchCount: number; groups: GrepFileGroup[] } | null {
  if (!output) return null;
  const text = String(output).trim();
  const headerMatch = text.match(/^Found\s+(\d+)\s+match[^\n]*/i);
  const matchCount = headerMatch ? parseInt(headerMatch[1], 10) : 0;
  const body = headerMatch ? text.slice(headerMatch[0].length).trim() : text;
  if (!body) return null;
  const groups: GrepFileGroup[] = [];
  const lines = body.split('\n');
  let currentFile: string | null = null;
  let currentContent = '';

  const flush = () => {
    if (!currentFile || !currentContent) return;
    const matches: GrepMatch[] = [];
    const parts = currentContent.split(/(?=Line\s+\d+:)/g);
    for (const part of parts) {
      const lm = part.match(/^Line\s+(\d+):\s*([\s\S]*)/);
      if (lm) {
        const content = lm[2].trim().replace(/;$/, '');
        if (content) matches.push({ line: parseInt(lm[1], 10), content });
      }
    }
    if (matches.length) groups.push({ filePath: currentFile, matches });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fileMatch = trimmed.match(/^(\/[^:]+?):\s*(Line\s+\d+:[\s\S]*)?$/);
    if (fileMatch) {
      flush();
      currentFile = fileMatch[1];
      currentContent = fileMatch[2] || '';
    } else if (currentFile) {
      currentContent += ' ' + trimmed;
    }
  }
  flush();

  if (!groups.length) return null;
  return {
    matchCount: matchCount || groups.reduce((sum, g) => sum + g.matches.length, 0),
    groups,
  };
}

export function OcSearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocTool = (args._oc_tool as string) || 'search';
  const ocState = args._oc_state as any;
  const pattern = (args.pattern as string) || '';
  const path = (args.path as string) || '';
  const include = (args.include as string) || '';
  const output = toolResult?.output || ocState?.output || '';

  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();

  const toolLabel =
    ocTool === 'glob' ? 'Find Files'
    : ocTool === 'grep' ? 'Grep'
    : ocTool === 'list' ? 'List Directory'
    : 'Search';

  const detailParts: string[] = [];
  if (pattern) detailParts.push(pattern);
  if (include) detailParts.push(include);
  if (path) detailParts.push(path);
  const detail = detailParts.join(' · ') || undefined;

  const isError = toolResult?.success === false || !!toolResult?.error;

  const filePaths = useMemo(() => {
    if (ocTool === 'grep') return null;
    return parseFilePaths(String(output));
  }, [output, ocTool]);
  const grepResult = useMemo(() => {
    if (ocTool !== 'grep') return null;
    return parseGrepOutput(String(output));
  }, [output, ocTool]);

  const resultCount = filePaths?.length ?? grepResult?.matchCount ?? null;

  if (isStreaming && !toolResult) {
    return <LoadingState title={toolLabel} subtitle={detail} />;
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={Search}
        title={toolLabel}
        detail={detail}
        actions={
          resultCount != null && resultCount > 0 ? (
            <Counter
              value={resultCount}
              label={
                filePaths
                  ? resultCount === 1 ? 'file' : 'files'
                  : resultCount === 1 ? 'match' : 'matches'
              }
            />
          ) : null
        }
      />

      <ToolViewBody padded={false}>
        {filePaths && filePaths.length > 0 ? (
          <FilePathList
            paths={filePaths}
            toDisplayPath={toDisplayPath}
            onFileClick={(fp) => openFileWithList(fp, filePaths)}
          />
        ) : grepResult ? (
          <GrepResultList
            groups={grepResult.groups}
            toDisplayPath={toDisplayPath}
            onFileClick={(fp) => openFile(fp)}
          />
        ) : output ? (
          <div className="px-4 py-3">
            <UnifiedMarkdown content={String(output)} isStreaming={false} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-muted-foreground/60">
            <FolderOpen className="w-5 h-5 mb-2 opacity-50" />
            <span className="text-xs tracking-tight">No results</span>
          </div>
        )}
      </ToolViewBody>

      <ToolViewFoot timestamp={ts}>
        {isError ? (
          <Status tone="error">
            <AlertCircle className="w-3 h-3" />
            Failed
          </Status>
        ) : (
          <Status tone="success">Done</Status>
        )}
      </ToolViewFoot>
    </ToolViewShell>
  );
}

// ── Subviews ────────────────────────────────────────────────────────────────

function FilePathList({
  paths,
  toDisplayPath,
  onFileClick,
}: {
  paths: string[];
  toDisplayPath: (p: string) => string;
  onFileClick: (path: string) => void;
}) {
  return (
    <div className="divide-y divide-border/40">
      {paths.map((fp, i) => {
        const dp = toDisplayPath(fp);
        const name = getFilename(dp);
        const dir = getDirectory(dp);
        return (
          <button
            key={i}
            onClick={() => onFileClick(fp)}
            title={dp}
            className="group w-full flex items-center gap-2.5 px-4 py-2 hover:bg-foreground/[0.025] transition-colors cursor-pointer text-left"
          >
            <FileText className="w-3.5 h-3.5 text-muted-foreground/60 group-hover:text-foreground/80 flex-shrink-0 transition-colors" />
            <span className="text-sm font-mono font-medium text-foreground/90 flex-shrink-0">
              {name}
            </span>
            {dir && (
              <span className="text-xs font-mono text-muted-foreground/50 truncate flex-1">{dir}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function GrepResultList({
  groups,
  toDisplayPath,
  onFileClick,
}: {
  groups: GrepFileGroup[];
  toDisplayPath: (p: string) => string;
  onFileClick: (path: string) => void;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(
    groups.length === 1 ? 0 : null,
  );

  return (
    <div className="divide-y divide-border/40">
      {groups.map((group, i) => {
        const dp = toDisplayPath(group.filePath);
        const name = getFilename(dp);
        const dir = getDirectory(dp);
        const isExpanded = expandedIndex === i;
        return (
          <div key={i}>
            <div
              role="button"
              onClick={() => setExpandedIndex(isExpanded ? null : i)}
              className="group flex items-center gap-2 px-4 py-2 hover:bg-foreground/[0.025] transition-colors cursor-pointer"
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
              )}
              <FileText className="w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0" />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileClick(group.filePath);
                }}
                className="text-sm font-mono font-medium text-foreground/90 hover:text-foreground/70 transition-colors flex-shrink-0 cursor-pointer"
                title={dp}
              >
                {name}
              </button>
              {dir && (
                <span className="text-xs font-mono text-muted-foreground/50 truncate flex-1">
                  {dir}
                </span>
              )}
              <span className="text-xs tabular-nums text-muted-foreground/70 flex-shrink-0 font-mono">
                {group.matches.length}
              </span>
            </div>
            {isExpanded && (
              <div className="bg-foreground/[0.015] border-t border-border/40">
                <table className="w-full text-xs font-mono">
                  <tbody>
                    {group.matches.map((m, j) => (
                      <tr key={j} className="border-b last:border-b-0 border-border/30">
                        <td className="text-right pr-3 pl-4 py-1 text-muted-foreground/50 select-none w-14 align-top tabular-nums">
                          {m.line}
                        </td>
                        <td className="py-1 pr-4 text-foreground/85 break-all leading-relaxed">
                          {m.content}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
