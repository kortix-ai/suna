'use client';

import React, { useState } from 'react';
import { Eye, AlertCircle, FileText, ChevronRight, ChevronDown } from 'lucide-react';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { CodeHighlight } from '@/components/markdown/unified-markdown';
import { useOcFileOpen } from './useOcFileOpen';
import { formatTimestamp } from '../utils';
import { cn } from '@/lib/utils';
import {
  Counter,
  Status,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewLabel,
  ToolViewShell,
} from '../shared/primitives';

function getFilename(path?: string): string {
  if (!path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getDirectory(path?: string): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.substring(0, idx);
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx < 0 ? '' : filename.substring(idx + 1);
}

function cleanReadOutput(raw: string): string {
  return raw
    .replace(/<\/?file>/g, '')
    .replace(/^\d{4,5}\|\s?/gm, '')
    .trim();
}

export function OcReadToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const filePath = (args.filePath as string) || '';
  const ocState = args._oc_state as any;
  const filename = getFilename(filePath);
  const ext = getExtension(filename);

  const metadata = ocState?.metadata || {};
  const loaded: string[] = Array.isArray(metadata?.loaded) ? metadata.loaded : [];
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = rawOutput ? cleanReadOutput(String(rawOutput)) : '';
  const lineCount = output ? output.split('\n').length : null;
  const isError = toolResult?.success === false || !!toolResult?.error;

  const allPaths = loaded.length > 0 ? loaded : filePath ? [filePath] : [];
  const isSingleFile = allPaths.length <= 1;

  const { openFile, openFileWithList, toDisplayPath } = useOcFileOpen();
  const displayPath = toDisplayPath(filePath);
  const displayDir = getDirectory(displayPath);
  const [expanded, setExpanded] = useState(false);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Reading file" subtitle={filename || filePath} />;
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={Eye}
        title={filename || 'Read File'}
        detail={displayDir}
        onTitleClick={filePath ? () => openFile(filePath) : undefined}
        actions={
          <>
            {allPaths.length > 1 && (
              <Counter value={allPaths.length} label={allPaths.length === 1 ? 'file' : 'files'} />
            )}
            {lineCount != null && lineCount > 0 && (
              <Counter value={lineCount} label={lineCount === 1 ? 'line' : 'lines'} />
            )}
          </>
        }
      />

      <ToolViewBody padded={false}>
        {isSingleFile ? (
          <div className="px-4 py-3">
            <SingleFile
              filePath={filePath}
              displayPath={displayPath}
              ext={ext}
              output={output}
              expanded={expanded}
              onToggle={() => setExpanded(!expanded)}
              onOpenFile={() => openFileWithList(filePath, allPaths)}
            />
          </div>
        ) : (
          <MultiFileList
            paths={allPaths}
            toDisplayPath={toDisplayPath}
            onFileClick={(fp) => openFileWithList(fp, allPaths)}
          />
        )}
      </ToolViewBody>

      <ToolViewFoot timestamp={ts}>
        {isError ? (
          <Status tone="error">
            <AlertCircle className="w-3 h-3" />
            Failed
          </Status>
        ) : (
          <Status tone="success">Read</Status>
        )}
      </ToolViewFoot>
    </ToolViewShell>
  );
}

function SingleFile({
  filePath,
  displayPath,
  ext,
  output,
  expanded,
  onToggle,
  onOpenFile,
}: {
  filePath: string;
  displayPath: string;
  ext: string;
  output: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: () => void;
}) {
  const hasContent = !!output;
  const filename = getFilename(displayPath);
  const dir = getDirectory(displayPath);

  return (
    <div className="rounded-2xl border border-border/50 overflow-hidden bg-foreground/[0.02]">
      <div
        role={hasContent ? 'button' : undefined}
        onClick={hasContent ? onToggle : undefined}
        className={cn(
          'flex items-center gap-2.5 px-3 py-2 transition-colors',
          hasContent && 'cursor-pointer hover:bg-foreground/[0.04]',
        )}
      >
        {hasContent ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
          )
        ) : (
          <FileText className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile();
          }}
          className="text-sm font-mono font-medium text-foreground/90 hover:text-foreground/70 transition-colors flex-shrink-0 cursor-pointer"
          title={displayPath}
        >
          {filename}
        </button>
        {dir && (
          <span className="text-xs font-mono text-muted-foreground/50 truncate flex-1">{dir}</span>
        )}
        {hasContent && (
          <span className="text-xs text-muted-foreground/60 uppercase tracking-wider flex-shrink-0">
            {expanded ? 'hide' : 'show'}
          </span>
        )}
      </div>
      {expanded && hasContent && (
        <div className="border-t border-border/50">
          <CodeHighlight
            code={output}
            language={ext || 'text'}
            className="[&>pre]:rounded-none [&>pre]:border-0 [&>pre]:bg-transparent"
          />
        </div>
      )}
    </div>
  );
}

function MultiFileList({
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
        const fname = getFilename(dp);
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
              {fname}
            </span>
            {dir && (
              <span className="text-xs font-mono text-muted-foreground/50 truncate flex-1">
                {dir}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
