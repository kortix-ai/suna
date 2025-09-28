import React from 'react';
import {
  Play,
  Pause,
  CheckCircle,
  AlertTriangle,
  Settings,
  XCircle
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractActivateAgentWorkflowData } from './_utils';

export default function ActivateAgentWorkflowToolView({
  name = 'activate-agent-workflow',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const {
    agent_id,
    workflow_id,
    workflow_name,
    active,
    status,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractActivateAgentWorkflowData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);
  const isActive = status === 'active';
  const StatusIcon = isActive ? Play : Pause;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn(
              "relative p-2 rounded-xl border",
              isActive 
                ? "bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border-emerald-500/20"
                : "bg-gradient-to-br from-slate-500/20 to-slate-600/10 border-slate-500/20"
            )}>
              <Settings className={cn(
                "w-5 h-5",
                isActive 
                  ? "text-emerald-500 dark:text-emerald-400"
                  : "text-slate-500 dark:text-slate-400"
              )} />
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
              {actualIsSuccess ? 'Workflow updated' : 'Update failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Settings}
            iconColor={isActive ? "text-emerald-500 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"}
            bgColor={isActive 
              ? "bg-gradient-to-b from-emerald-100 to-emerald-50 shadow-inner dark:from-emerald-800/40 dark:to-emerald-900/60 dark:shadow-emerald-950/20"
              : "bg-gradient-to-b from-slate-100 to-slate-50 shadow-inner dark:from-slate-800/40 dark:to-slate-900/60 dark:shadow-slate-950/20"
            }
            title="Updating workflow"
            filePath={workflow_name ? `"${workflow_name}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && workflow_name ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border border-border rounded-xl p-4 space-y-4 bg-muted/20 dark:bg-muted/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "w-12 h-12 rounded-xl border flex items-center justify-center",
                      isActive 
                        ? "bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border-emerald-500/20"
                        : "bg-gradient-to-br from-slate-500/20 to-slate-600/10 border-slate-500/20"
                    )}>
                      <StatusIcon className={cn(
                        "h-6 w-6",
                        isActive ? "text-emerald-600" : "text-slate-600"
                      )} />
                    </div>
                    <div className="space-y-1">
                      <h3 className="font-semibold text-foreground">{workflow_name}</h3>
                      <p className="text-sm text-muted-foreground">
                        Workflow {isActive ? 'activated' : 'deactivated'}
                      </p>
                    </div>
                  </div>
                  <Badge 
                    variant={isActive ? "default" : "secondary"}
                    className={cn(
                      "text-xs",
                      isActive && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400"
                    )}
                  >
                    <StatusIcon className="h-3 w-3 mr-1" />
                    {status?.charAt(0).toUpperCase() + status?.slice(1)}
                  </Badge>
                </div>

                <Separator />

                <div className="pt-2">
                  <div className={cn(
                    "flex items-center gap-2 text-sm",
                    isActive 
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-slate-700 dark:text-slate-400"
                  )}>
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      isActive ? "bg-emerald-500" : "bg-slate-500"
                    )} />
                    {isActive 
                      ? "The workflow is now active and can be executed."
                      : "The workflow is now inactive and won't run until reactivated."
                    }
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 text-center">
            <div className="space-y-2">
              <AlertTriangle className="h-8 w-8 text-red-500 mx-auto" />
              <p className="text-sm font-medium text-foreground">Failed to update workflow</p>
              <p className="text-xs text-muted-foreground">Please check the workflow configuration and try again.</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 