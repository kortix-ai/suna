'use client';

import React, { useMemo } from 'react';
import {
  Terminal,
  CheckCircle,
  AlertCircle,
  FolderOpen,
  Hash,
  Clock,
  XCircle,
  Keyboard,
  Type,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { PreWithPaths } from '@/components/common/clickable-path';
import { STATUS_TEXT, StatusDot } from '@/components/ui/status';
import { InfoBanner } from '@/components/ui/info-banner';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Format a duration in ms to human-readable */
function formatDuration(startMs: number, endMs: number): string {
  const diff = endMs - startMs;
  if (diff < 1000) return `${diff}ms`;
  if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`;
  return `${(diff / 60000).toFixed(1)}m`;
}

/** Parse structured output from pty_spawned XML tags */
function parsePtySpawnedOutput(output: string): Record<string, string> | null {
  const match = output.match(/<pty_spawned>([\s\S]*?)<\/pty_spawned>/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].trim().split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }
  return fields;
}

/** Parse pty_output XML tags from read output */
function parsePtyReadOutput(output: string): {
  id: string;
  ptyStatus: string;
  content: string;
  bufferInfo: string;
} {
  const match = output.match(/<pty_output\s+([^>]*)>([\s\S]*?)<\/pty_output>/);
  if (!match) return { id: '', ptyStatus: '', content: stripAnsi(output), bufferInfo: '' };

  const attrs = match[1];
  const rawContent = match[2];

  const idMatch = attrs.match(/id="([^"]+)"/);
  const statusMatch = attrs.match(/status="([^"]+)"/);

  const lines = rawContent.trim().split('\n');
  const contentLines: string[] = [];
  let bufferInfo = '';

  for (const line of lines) {
    if (/^\(End of buffer/.test(line.trim())) {
      bufferInfo = line.trim();
      continue;
    }
    contentLines.push(line.replace(/^\d{5}\|\s?/, ''));
  }

  return {
    id: idMatch?.[1] || '',
    ptyStatus: statusMatch?.[1] || '',
    content: stripAnsi(contentLines.join('\n').trim()),
    bufferInfo,
  };
}

/* ------------------------------------------------------------------ */
/*  StatusBadge                                                       */
/* ------------------------------------------------------------------ */

function StatusBadge({ status }: { status: string }) {
  const isRunning = status === 'running';
  const isError = status === 'error' || status === 'failed';
  const isCompleted = status === 'completed' || status === 'exited' || status === 'stopped';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium tracking-tight',
        isError ? STATUS_TEXT.destructive : 'text-muted-foreground/80',
      )}
    >
      {isRunning && <StatusDot tone="neutral" pulse className="bg-foreground" />}
      {isError && <AlertCircle className="w-2.5 h-2.5" />}
      {isCompleted && <CheckCircle className="w-2.5 h-2.5 text-foreground/70" />}
      {status}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  InfoRow - reusable key-value row                                  */
/* ------------------------------------------------------------------ */

function InfoRow({
  icon: Icon,
  label,
  value,
  mono = false,
  truncate = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2.5 px-3 py-2">
      <Icon className="size-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground/60 font-medium mb-0.5">
          {label}
        </div>
        <div
          className={cn(
            'text-xs text-foreground break-all',
            mono && 'font-mono',
            truncate && 'truncate',
          )}
          title={truncate ? value : undefined}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  OcPtySpawnToolView                                                */
/* ================================================================== */

export function OcPtySpawnToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;

  // Input fields
  const command = (args.command as string) || '';
  const cmdArgs = args.args as string[] | undefined;
  const workdir = (args.workdir as string) || '';
  const title = (args.title as string) || '';
  const description = (args.description as string) || '';

  // Build full command string
  const fullCommand = useMemo(() => {
    if (!command) return '';
    if (cmdArgs && cmdArgs.length > 0) {
      return `${command} ${cmdArgs.join(' ')}`;
    }
    return command;
  }, [command, cmdArgs]);

  // Parse output if available
  const parsedOutput = useMemo(() => {
    const raw = toolResult?.output || '';
    if (typeof raw === 'string') return parsePtySpawnedOutput(raw);
    return null;
  }, [toolResult?.output]);

  const processStatus = parsedOutput?.Status || ocState?.status || '';
  const pid = parsedOutput?.PID || '';
  const ptyId = parsedOutput?.ID || '';

  const isError = toolResult?.success === false || !!toolResult?.error || ocState?.status === 'error';
  const errorMessage = (ocState?.error as string) || toolResult?.error || '';

  // Timing info
  const timing = ocState?.time as { start?: number; end?: number } | undefined;

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Spawning Process"
        subtitle={title || fullCommand}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Terminal}
            title={title || 'Spawn Process'}
            subtitle={description || fullCommand}
          />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3 space-y-3">
            {/* Error banner */}
            {isError && errorMessage && (
              <InfoBanner tone="destructive" icon={AlertCircle} title="Error">
                <span className="break-words whitespace-pre-wrap font-mono">{errorMessage}</span>
              </InfoBanner>
            )}

            {/* Command display */}
            {fullCommand && (
              <div className="rounded-2xl border border-border overflow-hidden bg-zinc-950 dark:bg-zinc-950">
                <div className="px-3 py-2.5">
                  <pre className={cn('font-mono text-xs leading-relaxed', STATUS_TEXT.success)}>
                    <span className="text-muted-foreground">$ </span>
                    {fullCommand}
                  </pre>
                </div>
              </div>
            )}

            {/* Info section */}
            <div className="rounded-2xl border border-border overflow-hidden bg-card">
              <div className="divide-y divide-border">
                {workdir && (
                  <InfoRow icon={FolderOpen} label="Working Directory" value={workdir} mono />
                )}
                {description && title && (
                  <InfoRow icon={Type} label="Description" value={description} />
                )}
                {ptyId && (
                  <InfoRow icon={Hash} label="Terminal ID" value={ptyId} mono />
                )}
                {pid && (
                  <InfoRow icon={Hash} label="PID" value={pid} mono />
                )}
                {timing?.start && timing?.end && (
                  <InfoRow
                    icon={Clock}
                    label="Duration"
                    value={formatDuration(timing.start, timing.end)}
                  />
                )}
              </div>
            </div>

            {/* Status badges */}
            {processStatus && (
              <div className="flex items-center gap-2 px-1">
                <StatusBadge status={processStatus} />
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-foreground/70" />
              Spawned
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

/* ================================================================== */
/*  OcPtyReadToolView                                                 */
/* ================================================================== */

export function OcPtyReadToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;

  const ptyId = (args.id as string) || (args.pty_id as string) || '';
  const rawOutput = toolResult?.output || '';
  const isError = toolResult?.success === false || !!toolResult?.error;

  const parsed = useMemo(() => {
    if (typeof rawOutput === 'string') return parsePtyReadOutput(rawOutput);
    return { id: '', ptyStatus: '', content: '', bufferInfo: '' };
  }, [rawOutput]);

  const displayId = parsed.id || ptyId;

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Reading Terminal"
        subtitle={displayId || undefined}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Terminal}
            title="Terminal Output"
            subtitle={displayId || undefined}
          />
          {parsed.ptyStatus && (
            <StatusBadge status={parsed.ptyStatus} />
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3 space-y-3">
            {isError && (
              <InfoBanner tone="destructive" icon={AlertCircle}>
                {toolResult?.error || 'Failed to read terminal'}
              </InfoBanner>
            )}

            {parsed.content && (
              <div className="rounded-2xl border border-border overflow-hidden bg-zinc-950 dark:bg-zinc-950">
                <PreWithPaths
                  text={parsed.content}
                  className="p-3 font-mono text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap break-words"
                />
                {parsed.bufferInfo && (
                  <div className="px-3 pb-2 text-xs text-muted-foreground italic border-t border-border">
                    <span className="pt-1.5 inline-block">{parsed.bufferInfo}</span>
                  </div>
                )}
              </div>
            )}

            {!parsed.content && !isError && (
              <div className="text-sm text-muted-foreground px-1">
                No output available.
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-foreground/70" />
              Read
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

/* ================================================================== */
/*  OcPtyWriteToolView                                                */
/* ================================================================== */

export function OcPtyWriteToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;

  const ptyInput = (args.input as string) || (args.text as string) || '';
  const ptyId = (args.id as string) || (args.pty_id as string) || '';
  const isError = toolResult?.success === false || !!toolResult?.error;
  const errorMessage = (ocState?.error as string) || toolResult?.error || '';

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Sending Input"
        subtitle={ptyId || undefined}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Keyboard}
            title="Terminal Input"
            subtitle={ptyId || undefined}
          />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3 space-y-3">
            {isError && errorMessage && (
              <InfoBanner tone="destructive" icon={AlertCircle}>{errorMessage}</InfoBanner>
            )}

            {ptyInput && (
              <div className="rounded-2xl border border-border overflow-hidden bg-zinc-950 dark:bg-zinc-950">
                <div className="px-3 py-2.5">
                  <pre className={cn('font-mono text-xs leading-relaxed', STATUS_TEXT.warning)}>
                    <span className="text-muted-foreground">&gt; </span>
                    {ptyInput}
                  </pre>
                </div>
              </div>
            )}

            {ptyId && (
              <div className="rounded-2xl border border-border overflow-hidden bg-card">
                <InfoRow icon={Hash} label="Terminal ID" value={ptyId} mono />
              </div>
            )}

            {!ptyInput && !isError && (
              <div className="text-sm text-muted-foreground px-1">
                Empty input sent.
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-foreground/70" />
              Sent
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

/* ================================================================== */
/*  OcPtyKillToolView                                                 */
/* ================================================================== */

export function OcPtyKillToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;

  const ptyId = (args.id as string) || (args.pty_id as string) || '';
  const isError = toolResult?.success === false || !!toolResult?.error;
  const errorMessage = (ocState?.error as string) || toolResult?.error || '';

  // Clean output: strip XML tags
  const cleanOutput = useMemo(() => {
    const raw = toolResult?.output || '';
    if (typeof raw !== 'string') return '';
    return raw
      .replace(/<\/?[\w_]+(?:\s[^>]*)?>[\s\S]*?(?:<\/[\w_]+>)?/g, '')
      .trim() || raw.replace(/<\/?[\w_]+[^>]*>/g, '').trim();
  }, [toolResult?.output]);

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Killing Process"
        subtitle={ptyId || undefined}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={XCircle}
            title="Kill Process"
            subtitle={ptyId || undefined}
          />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3 space-y-3">
            {isError && errorMessage && (
              <InfoBanner tone="destructive" icon={AlertCircle}>{errorMessage}</InfoBanner>
            )}

            {ptyId && (
              <div className="rounded-2xl border border-border overflow-hidden bg-card">
                <InfoRow icon={Hash} label="Terminal ID" value={ptyId} mono />
              </div>
            )}

            {cleanOutput && (
              <div className="rounded-2xl border border-border overflow-hidden bg-zinc-950 dark:bg-zinc-950">
                <PreWithPaths
                  text={cleanOutput}
                  className="p-3 font-mono text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap break-words"
                />
              </div>
            )}

            {!ptyId && !cleanOutput && !isError && (
              <div className="text-sm text-muted-foreground px-1">
                Process terminated.
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <XCircle className={cn('h-3 w-3', STATUS_TEXT.destructive)} />
              Killed
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
