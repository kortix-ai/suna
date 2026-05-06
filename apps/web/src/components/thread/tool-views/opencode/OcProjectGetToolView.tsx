'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Folder,
  Clock,
  FileText,
  Hash,
  Users,
  CheckSquare,
  Square,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';

// ============================================================================
// Types & Parsing
// ============================================================================

interface ProjectGetData {
  name: string;
  path: string;
  description: string | null;
  id: string;
  sessions: Array<{ status: string; count: number }>;
  contextExists: boolean;
  contextPath: string;
}

function parseProjectGetOutput(output: string): ProjectGetData | null {
  if (!output || typeof output !== 'string') return null;

  const nameMatch = output.match(/^##\s+(.+)$/m);
  const pathMatch = output.match(/\*\*Path:\*\*\s+`([^`]+)`/);
  const descMatch = output.match(/\*\*Description:\*\*\s+(.+)$/m);
  const idMatch = output.match(/\*\*ID:\*\*\s+`([^`]+)`/);
  const contextMatch = output.match(/\*\*Context:\*\*\s+`([^`]+)`\s*([✓✓])?/);
  const contextExists = !!contextMatch?.[2];
  const contextPath = contextMatch?.[1] || '';

  // Sessions section: - status: count
  const sessions: Array<{ status: string; count: number }> = [];
  const sessionRe = /^\|\s*-\s+(running|completed|failed|pending):\s+(\d+)/gm;
  // Also match bullet points without pipe
  const bulletRe = /^-\s+(running|completed|failed|pending):\s+(\d+)/gm;
  
  let m;
  while ((m = bulletRe.exec(output)) !== null) {
    sessions.push({
      status: m[1],
      count: parseInt(m[2], 10) || 0,
    });
  }

  // Also try "Sessions" header followed by list
  const sessionsSection = output.match(/^### Sessions$\s*\n([\s\S]*?)(?=^##|\n\n|$)/m);
  if (sessionsSection && sessions.length === 0) {
    const lines = sessionsSection[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*-\s+(running|completed|failed|pending):\s+(\d+)/);
      if (match) {
        sessions.push({
          status: match[1],
          count: parseInt(match[2], 10) || 0,
        });
      }
    }
  }

  return {
    name: nameMatch?.[1] || 'Workspace',
    path: pathMatch?.[1] || '',
    description: descMatch?.[1] || null,
    id: idMatch?.[1] || '',
    sessions,
    contextExists,
    contextPath,
  };
}

// ============================================================================
// Component
// ============================================================================

export function OcProjectGetToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const projectName = (args.name as string) || (ocState?.input?.name as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const data = useMemo(() => parseProjectGetOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Loading workspace" subtitle={projectName || 'Fetching workspace details...'} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Folder}
            title={data?.name ?? 'Workspace'}
            subtitle={projectName}
          />
          {data?.id && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2 font-mono text-[10px]">
              <Hash className="h-3 w-3 mr-1 opacity-70" />
              {data.id.slice(0, 12)}...
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {data ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              {/* Metadata */}
              <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground/70">
                <div className="flex items-center gap-2">
                  <Folder className="size-3.5" />
                  <span className="font-mono truncate" title={data.path}>{data.path}</span>
                </div>
                {data.description && (
                  <div className="flex items-center gap-2">
                    <FileText className="size-3.5" />
                    <span>{data.description}</span>
                  </div>
                )}
              </div>

              {/* Sessions */}
              {data.sessions.length > 0 && (
                <div className="rounded-lg border border-border/50 overflow-hidden">
                  <div className="px-3 py-2 bg-muted/30 border-b border-border/30 flex items-center gap-2">
                    <Users className="size-3.5" />
                    <span className="text-xs font-medium">Sessions</span>
                  </div>
                  <div className="p-3 flex flex-wrap gap-2">
                    {data.sessions.map((s) => (
                      <Badge
                        key={s.status}
                        variant="outline"
                        className={cn(
                          'h-6 py-0',
                          s.status === 'running' && 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-300',
                          s.status === 'completed' && 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300',
                          s.status === 'failed' && 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-300',
                          s.status === 'pending' && 'bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800/50 text-yellow-700 dark:text-yellow-300',
                        )}
                      >
                        {s.status}: {s.count}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Context file status */}
              {data.contextPath && (
                <div className="flex items-center gap-2 text-xs">
                  {data.contextExists ? (
                    <>
                      <CheckSquare className="size-3.5 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400">Context file ready</span>
                      <span className="text-muted-foreground/50 font-mono truncate ml-1" title={data.contextPath}>
                        {data.contextPath}
                      </span>
                    </>
                  ) : (
                    <>
                      <Square className="size-3.5 text-muted-foreground/40" />
                      <span className="text-muted-foreground/60">No context file yet</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {output.slice(0, 5000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to retrieve project'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Folder className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No project data</p>
          </div>
        )}
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
          ) : data ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              Loaded
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
