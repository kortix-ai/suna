'use client';

/**
 * Renderer for the unified task orchestration system + legacy agent_spawn/message/stop/status.
 */

import React from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Cpu,
  ListTodo,
  Play,
  CircleDot,
  Pencil,
  XCircle,
  MessageSquare,
} from 'lucide-react';
import type { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';

/** Map tool function name → display config */
const TOOL_CONFIG: Record<string, { icon: typeof Cpu; label: string; verb: string }> = {
  // Canonical task orchestration system
  task_create:       { icon: Cpu,            label: 'Task Create',     verb: 'Spawning worker' },
  task_update:       { icon: Pencil,         label: 'Task Update',     verb: 'Updating task' },
  task_list:         { icon: ListTodo,       label: 'Task List',       verb: 'Listing tasks' },
  task_get:          { icon: CircleDot,      label: 'Task Details',    verb: 'Reading task' },
  // Compatibility aliases
  agent_task:        { icon: Cpu,            label: 'Agent Task',      verb: 'Spawning worker' },
  agent_task_update: { icon: Pencil,         label: 'Task Update',     verb: 'Updating task' },
  agent_task_list:   { icon: ListTodo,       label: 'Task List',       verb: 'Listing tasks' },
  agent_task_get:    { icon: CircleDot,      label: 'Task Details',    verb: 'Reading task' },
  // Legacy agent tools (still appear in old sessions)
  agent_spawn:       { icon: Cpu,            label: 'Agent Spawn',     verb: 'Spawning worker' },
  agent_message:     { icon: MessageSquare,  label: 'Agent Message',   verb: 'Messaging worker' },
  agent_stop:        { icon: XCircle,        label: 'Agent Stop',      verb: 'Stopping worker' },
  agent_status:      { icon: ListTodo,       label: 'Agent Status',    verb: 'Checking workers' },
  // Legacy task tools
  task:              { icon: Cpu,            label: 'Sub-Agent Task',  verb: 'Running task' },
};

function getToolName(toolCall: any): string {
  const name = toolCall?.function_name || '';
  return name.replace(/^oc-/, '').replace(/-/g, '_');
}

export function OcKortixTaskToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const toolName = getToolName(toolCall);
  const config = TOOL_CONFIG[toolName] || { icon: Cpu, label: 'Agent Task', verb: 'Processing' };
  const Icon = config.icon;

  const args = toolCall?.arguments || {};
  const ocState = (args as any)?._oc_state;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  // Extract display info from args
  const title = (args.title as string) || (args.description as string) || '';
  const taskId = (args.id as string) || (args.agent_id as string) || '';
  const action = (args.action as string) || '';
  const message = (args.message as string) || (args.prompt as string) || '';

  // Build subtitle
  let subtitle = title || taskId || '';
  if (action && taskId) {
    subtitle = `${action} → ${taskId}`;
  }
  if (!subtitle && message) {
    subtitle = message.slice(0, 80);
  }

  if (isStreaming && !toolResult) {
    return <LoadingState title={config.verb} subtitle={subtitle} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Icon}
            title={config.label}
            subtitle={subtitle}
          />
          {!isStreaming && (
            <Badge
              variant={isError ? 'destructive' : 'secondary'}
              className="h-6 py-0.5"
            >
              {isError ? (
                <><AlertCircle className="h-3 w-3 mr-1" />Error</>
              ) : (
                <><CheckCircle2 className="h-3 w-3 mr-1" />Done</>
              )}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3">
            {output ? (
              <UnifiedMarkdown content={output} isStreaming={false} />
            ) : message ? (
              <div className="text-sm text-muted-foreground">{message.slice(0, 300)}</div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {config.verb}...
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      />
    </Card>
  );
}
