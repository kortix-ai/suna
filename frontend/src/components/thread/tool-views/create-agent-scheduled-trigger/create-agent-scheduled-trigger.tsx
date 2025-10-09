import React from 'react';
import {
  Clock,
  CheckCircle,
  AlertTriangle,
  Calendar,
  Play,
  FileText,
  Bot,
  Zap
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractCreateAgentScheduledTriggerData } from './_utils';

export default function CreateAgentScheduledTriggerToolView({
  name = 'create-agent-scheduled-trigger',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const {
    agent_id,
    name: triggerName,
    description,
    cron_expression,
    agent_prompt,
    trigger,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCreateAgentScheduledTriggerData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const formatCronExpression = (cron: string): string => {
    const cronMap: Record<string, string> = {
      '0 0 * * *': 'Daily at midnight',
      '0 9 * * *': 'Daily at 9:00 AM',
      '30 3 * * *': 'Daily at 3:30 AM',
      '0 8 * * 1': 'Every Monday at 8:00 AM',
      '0 18 * * 5': 'Every Friday at 6:00 PM',
      '*/30 * * * *': 'Every 30 minutes',
      '0 */6 * * *': 'Every 6 hours',
    };
    
    return cronMap[cron] || `Custom schedule: ${cron}`;
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
              <Clock className="w-5 h-5 text-purple-500 dark:text-purple-400" />
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
              {actualIsSuccess ? 'Trigger created' : 'Creation failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Clock}
            iconColor="text-purple-500 dark:text-purple-400"
            bgColor="bg-gradient-to-b from-purple-100 to-purple-50 shadow-inner dark:from-purple-800/40 dark:to-purple-900/60 dark:shadow-purple-950/20"
            title="Creating scheduled trigger"
            filePath={triggerName ? `"${triggerName}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && trigger ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border border-border rounded-xl p-4 space-y-4 bg-muted/20 dark:bg-muted/10">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20 flex items-center justify-center">
                      <Clock className="h-6 w-6 text-purple-600" />
                    </div>
                    <div className="space-y-1">
                      <h3 className="font-semibold text-foreground">{trigger.name}</h3>
                      {trigger.description && (
                        <p className="text-sm text-muted-foreground">{trigger.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      <Play className="h-3 w-3 mr-1" />
                      {trigger.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                    <Badge variant="outline" className="text-xs border-purple-200 text-purple-700 bg-purple-50">
                      <Bot className="h-3 w-3 mr-1" />
                      Agent
                    </Badge>
                  </div>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Schedule</p>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm text-foreground font-mono">{trigger.cron_expression}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatCronExpression(trigger.cron_expression)}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Created</p>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        {new Date(trigger.created_at).toLocaleDateString()} at{' '}
                        {new Date(trigger.created_at).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                </div>


                {agent_prompt && (
                  <>
                    <Separator />
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-foreground">Agent Prompt</p>
                      <div className="p-3 bg-muted border border-border rounded-lg text-sm text-foreground">
                        {agent_prompt}
                      </div>
                    </div>
                  </>
                )}

                <div className="pt-2 border-t border-border">
                  <div className="flex items-center gap-2 text-sm text-purple-700 dark:text-purple-400">
                    <div className="w-2 h-2 bg-purple-500 rounded-full" />
                    The scheduled trigger is now active and will run automatically according to the schedule.
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 text-center">
            <div className="space-y-2">
              <AlertTriangle className="h-8 w-8 text-red-500 mx-auto" />
              <p className="text-sm font-medium text-foreground">Failed to create scheduled trigger</p>
              <p className="text-xs text-muted-foreground">Please check the trigger configuration and try again.</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 