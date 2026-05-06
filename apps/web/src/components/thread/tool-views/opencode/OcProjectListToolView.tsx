'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Folder,
  Hash,
  FileText,
  Users,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { parseProjectListOutput, type ProjectEntry } from '@/lib/utils/kortix-tool-output';

export function OcProjectListToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const { projects, total } = useMemo(() => {
    const parsed = parseProjectListOutput(output);
    // Extract total count from legacy footer like "2 projects."
    const totalMatch = output.match(/(\d+)\s+project/);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : parsed.length;
    return { projects: parsed, total };
  }, [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Loading workspace" subtitle="Fetching workspace details..." />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Folder}
            title="Workspace"
            subtitle={projects.length > 0 ? 'Global workspace' : 'Workspace details'}
          />
          {projects.length > 0 && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2">
              <Hash className="h-3 w-3 mr-1 opacity-70" />
              {projects.length}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {projects.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="divide-y divide-border/40">
              {projects.map((project: ProjectEntry) => (
                <div key={project.path} className="px-4 py-3 hover:bg-muted/20 transition-colors">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-foreground truncate flex-1">
                      {project.name}
                    </span>
                    {project.sessions > 0 && (
                      <Badge variant="outline" className="h-4 py-0 text-[0.5625rem] font-normal bg-emerald-50/50 dark:bg-emerald-950/30 border-emerald-200/50 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300">
                        <Users className="size-3 mr-0.5" />
                        {project.sessions}
                      </Badge>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground/60 space-y-0.5">
                    <span className="font-mono truncate block" title={project.path}>
                      {project.path}
                    </span>
                    {project.description && project.description !== '—' && (
                      <span className="flex items-center gap-1 truncate" title={project.description}>
                        <FileText className="size-3 flex-shrink-0" />
                        {project.description}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {output.slice(0, 3000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to load workspace'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Folder className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No workspace details found</p>
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
          ) : projects.length > 0 ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              Workspace
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
