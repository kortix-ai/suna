import React from 'react';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  Calendar,
  Star,
  Play,
  Pause,
  Settings,
  ListChecks
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractListAgentWorkflowsData, WorkflowItem } from './_utils';

function WorkflowCard({ workflow }: { workflow: WorkflowItem }) {
  const isActive = workflow.status === 'active';
  const StatusIcon = isActive ? Play : Pause;

  return (
    <div className="border border-border rounded-xl p-4 space-y-3 bg-muted/20 dark:bg-muted/10 hover:bg-muted/30 dark:hover:bg-muted/20 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 flex-shrink-0 rounded-lg border flex items-center justify-center",
            isActive 
              ? "bg-gradient-to-br from-blue-500/20 to-blue-600/10 border-blue-500/20"
              : "bg-gradient-to-br from-slate-500/20 to-slate-600/10 border-slate-500/20"
          )}>
            <FileText className={cn(
              "h-5 w-5",
              isActive ? "text-blue-600" : "text-slate-600"
            )} />
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold text-foreground">{workflow.name}</h3>
            {workflow.description && (
              <p className="text-sm text-muted-foreground line-clamp-2">{workflow.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge variant="outline" className={cn(
            "text-xs",
            isActive 
              ? "border-emerald-200 dark:border-emerald-800 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 dark:text-emerald-400"
              : "border-slate-200 dark:border-slate-800 text-slate-700 bg-slate-50 dark:bg-slate-950/50 dark:text-slate-400"
          )}>
            <StatusIcon className="h-3 w-3" />
            {workflow.status}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">{workflow.steps_count} step{workflow.steps_count !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            {new Date(workflow.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ListAgentWorkflowsToolView({
  name = 'list-agent-workflows',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const {
    agent_id,
    workflows,
    total_count,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractListAgentWorkflowsData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <FileText className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={cn(
                "text-xs font-medium",
                actualIsSuccess
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800"
                  : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
              )}
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {actualIsSuccess ? `${total_count} workflows` : 'Failed to load'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={FileText}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Loading workflows"
            showProgress={true}
          />
        ) : actualIsSuccess && workflows ? (
          workflows.length > 0 ? (
            <ScrollArea className="h-full w-full">
              <div className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <h3 className="text-lg font-semibold text-foreground">Agent Workflows</h3>
                    <p className="text-sm text-muted-foreground">
                      {total_count} workflow{total_count !== 1 ? 's' : ''} configured for this agent
                    </p>
                  </div>
                </div>
                
                <Separator />
                
                <div className="space-y-3">
                  {workflows.map((workflow) => (
                    <WorkflowCard key={workflow.id} workflow={workflow} />
                  ))}
                </div>
              </div>
            </ScrollArea>
          ) : (
            <div className="p-4 text-center">
              <div className="space-y-4">
                <div className="w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center mx-auto">
                  <FileText className="h-8 w-8 text-blue-500" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">No workflows found</p>
                  <p className="text-xs text-muted-foreground">
                    This agent doesn't have any workflows configured yet.
                  </p>
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="p-4 text-center">
            <div className="space-y-2">
              <AlertTriangle className="h-8 w-8 text-red-500 mx-auto" />
              <p className="text-sm font-medium text-foreground">Failed to load workflows</p>
              <p className="text-xs text-muted-foreground">Please try again or check the agent configuration.</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 