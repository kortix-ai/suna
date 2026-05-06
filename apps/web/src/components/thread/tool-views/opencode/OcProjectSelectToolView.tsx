'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Folder,
  ArrowRight,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { parseProjectSelectOutput } from '@/lib/utils/kortix-tool-output';

export function OcProjectSelectToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const projectArg = (args.project as string) || (ocState?.input?.project as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const data = useMemo(() => parseProjectSelectOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Activating workspace" subtitle={projectArg || 'Using global workspace...'} />;
  }

  // If we couldn't parse the output or it was an error, show the raw output
  if (!data || isError) {
    return (
      <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle
              icon={Folder}
              title="Workspace"
              subtitle={projectArg || 'Failed'}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0 h-full flex-1 overflow-hidden">
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to activate workspace'}</p>
          </div>
        </CardContent>
        <ToolViewFooter
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isStreaming={isStreaming}
        >
          <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
            <AlertCircle className="h-3 w-3" />
            Failed
          </Badge>
        </ToolViewFooter>
      </Card>
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Folder}
            title="Workspace Active"
            subtitle={data.name}
          />
          {data.success && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2">
              Active
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <div className="p-4 space-y-4">
          {/* Workspace name */}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted border border-border">
              <Folder className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{data.name}</p>
              <p className="text-xs text-muted-foreground">Global workspace is active for this session</p>
            </div>
          </div>

          {/* Path */}
          {data.path && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/70 bg-muted/30 rounded-lg p-3 font-mono truncate">
              <Folder className="size-3.5 flex-shrink-0" />
              <span className="truncate" title={data.path}>{data.path}</span>
            </div>
          )}

          {/* Next step hint */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground/60 bg-muted/20 rounded-lg p-3">
            <ArrowRight className="size-3.5 flex-shrink-0" />
            <span>You can now use file, bash, and edit tools</span>
          </div>
        </div>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && data.success && (
          <Badge variant="outline" className="h-6 py-0.5 bg-muted">
            Workspace active
          </Badge>
        )}
      </ToolViewFooter>
    </Card>
  );
}
