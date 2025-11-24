'use client';

import React, { useState, useMemo } from 'react';
import { AlertTriangle, ExternalLink, X, Square, Loader2, Zap, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UpgradeDialog } from '@/components/ui/upgrade-dialog';
import Link from 'next/link';
import { useStopAgentMutation } from '@/hooks/threads/use-agent-run';
import { AgentRun, getAgentRuns } from '@/lib/api/agents';
import { toast } from 'sonner';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { getThread } from '@/hooks/threads/utils';
import { getProject } from '@/lib/api/threads';
import { threadKeys } from '@/hooks/threads/keys';
import { usePricingModalStore } from '@/stores/pricing-modal-store';

interface RunningThreadInfo {
  threadId: string;
  name: string;
  projectId: string | null;
  projectName: string;
  agentRun: AgentRun | null;
  isLoading: boolean;
  error?: boolean;
}

interface RunningThreadItemProps {
  threadInfo: RunningThreadInfo;
  onThreadStopped: () => void;
}

const RunningThreadItem: React.FC<RunningThreadItemProps> = ({
  threadInfo,
  onThreadStopped,
}) => {
  const stopAgentMutation = useStopAgentMutation();
  const queryClient = useQueryClient();

  const handleStop = async () => {
    if (!threadInfo.agentRun?.id) return;
    
    try {
      await stopAgentMutation.mutateAsync(threadInfo.agentRun.id);
      
      // Invalidate relevant queries to refetch updated data
      await Promise.all([
        // Refetch agent runs for this thread to update the running status
        queryClient.invalidateQueries({
          queryKey: threadKeys.agentRuns(threadInfo.threadId)
        }),
        // Refetch thread details in case the status affects the thread
        queryClient.invalidateQueries({
          queryKey: threadKeys.details(threadInfo.threadId)
        })
      ]);
      
      toast.success('Agent stopped successfully');
      onThreadStopped();
    } catch (error) {
      console.error('Failed to stop agent:', error);
      toast.error('Failed to stop agent');
    }
  };

  const getThreadDisplayName = () => {
    if (threadInfo.name && threadInfo.name.trim()) {
      return threadInfo.name;
    }
    return `Thread ${threadInfo.threadId.slice(0, 8)}...`;
  };

  const getProjectDisplayName = () => {
    if (threadInfo.projectName && threadInfo.projectName.trim()) {
      return threadInfo.projectName;
    }
    return threadInfo.projectId ? `Project ${threadInfo.projectId.slice(0, 8)}...` : 'No Project';
  };

  return (
    <div className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2 gap-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {getProjectDisplayName()}
          </div>
          <code className="text-xs text-muted-foreground/70 truncate block">
            {threadInfo.threadId}
          </code>
        </div>
      </div>
      
      <div className="flex items-center gap-1">
        {threadInfo.agentRun && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 hover:bg-red-100 hover:text-red-600"
                onClick={handleStop}
                disabled={stopAgentMutation.isPending || threadInfo.isLoading}
              >
                {stopAgentMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Square className="h-3 w-3" />
                )}
                <span className="sr-only">Stop agent</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop this agent</TooltipContent>
          </Tooltip>
        )}
        
        {threadInfo.projectId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 hover:bg-background"
              >
                <Link href={`/projects/${threadInfo.projectId}/thread/${threadInfo.threadId}`} target="_blank">
                  <ExternalLink className="h-3 w-3" />
                  <span className="sr-only">Open thread</span>
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open thread</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

interface AgentRunLimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runningCount: number;
  runningThreadIds: string[];
  projectId?: string;
}

export const AgentRunLimitDialog: React.FC<AgentRunLimitDialogProps> = ({
  open,
  onOpenChange,
  runningCount,
  runningThreadIds,
  projectId,
}) => {
  const pricingModalStore = usePricingModalStore();
  
  const threadQueries = useQueries({
    queries: runningThreadIds.map(threadId => ({
      queryKey: threadKeys.details(threadId),
      queryFn: () => getThread(threadId),
      enabled: open && !!threadId,
      retry: 1,
    }))
  });

  const agentRunQueries = useQueries({
    queries: runningThreadIds.map(threadId => ({
      queryKey: threadKeys.agentRuns(threadId),
      queryFn: () => getAgentRuns(threadId),
      enabled: open && !!threadId,
      retry: 1,
    }))
  });

  const projectQueries = useQueries({
    queries: runningThreadIds.map(threadId => {
      const threadQuery = threadQueries.find((_, index) => runningThreadIds[index] === threadId);
      const projectId = threadQuery?.data?.project_id;
      
      return {
        queryKey: threadKeys.project(projectId || ""),
        queryFn: () => projectId ? getProject(projectId) : null,
        enabled: open && !!projectId,
        retry: 1,
      };
    })
  });

  const runningThreadsInfo: RunningThreadInfo[] = useMemo(() => {
    return runningThreadIds.map((threadId, index) => {
      const threadQuery = threadQueries[index];
      const agentRunQuery = agentRunQueries[index];
      const projectQuery = projectQueries[index];
      
      const isLoading = threadQuery.isLoading || agentRunQuery.isLoading || projectQuery.isLoading;
      const hasError = threadQuery.isError || agentRunQuery.isError || projectQuery.isError;
      
      const runningAgentRun = agentRunQuery.data?.find((run: AgentRun) => run.status === 'running') || null;
      
      let threadName = '';
      if (threadQuery.data?.messages?.length > 0) {
        const firstUserMessage = threadQuery.data.messages.find((msg: any) => msg.type === 'user');
        if (firstUserMessage?.content) {
          threadName = firstUserMessage.content.substring(0, 50);
          if (firstUserMessage.content.length > 50) threadName += '...';
        }
      }

      const projectId = threadQuery.data?.project_id || null;
      const projectName = projectQuery.data?.name || '';

      return {
        threadId,
        name: threadName,
        projectId,
        projectName,
        agentRun: runningAgentRun,
        isLoading,
        error: hasError,
      };
    });
  }, [runningThreadIds, threadQueries, agentRunQueries, projectQueries]);

  const isLoadingThreads = threadQueries.some(q => q.isLoading) || agentRunQueries.some(q => q.isLoading) || projectQueries.some(q => q.isLoading);

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleThreadStopped = () => {
  };

  const handleUpgrade = () => {
    pricingModalStore.openPricingModal({
      title: 'Upgrade to run more agents in parallel'
    });
    onOpenChange(false);
  };

  return (
    <UpgradeDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={AlertTriangle}
      title="Parallel Runs Limit Reached"
      description="You've reached the maximum parallel agent runs allowed."
      theme="warning"
      size="sm"
      actions={[
        {
          label: "Got it",
          onClick: handleClose,
          variant: "outline"
        }
      ]}
    >
      <Card className="border-primary/20 bg-primary/5 mb-4">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Rocket className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-sm">Need more parallel runs?</CardTitle>
              <CardDescription className="text-sm mt-1">
                Upgrade your plan to run multiple agents simultaneously and boost your productivity.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardFooter>
          <Button 
            onClick={handleUpgrade}
            size="sm"
            className="w-full"
          >
            <Zap className="h-4 w-4" />
            Upgrade Plan
          </Button>
        </CardFooter>
      </Card>

      {(runningThreadIds.length > 0 || runningCount > 0) && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">Currently Running Agents</h4>
          </div>
          
          {isLoadingThreads ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="ml-2 text-sm text-muted-foreground">Loading threads...</span>
            </div>
          ) : runningThreadIds.length === 0 ? (
            <div className="text-center py-4 text-sm text-muted-foreground">
              <p>Found {runningCount} running agents but unable to load thread details.</p>
              <p className="text-xs mt-1">Thread IDs: {JSON.stringify(runningThreadIds)}</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {runningThreadsInfo.slice(0, 5).map((threadInfo) => (
                <RunningThreadItem
                  key={threadInfo.threadId}
                  threadInfo={threadInfo}
                  onThreadStopped={handleThreadStopped}
                />
              ))}
              
              {runningThreadsInfo.length > 5 && (
                <div className="text-center py-2">
                  <Badge variant="outline" className="text-xs">
                    +{runningThreadsInfo.length - 5} more running
                  </Badge>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Separator />

      <div className="space-y-3">
        <h4 className="text-sm font-medium">What can you do?</h4>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground mt-2 flex-shrink-0" />
            <span>Click the <Square className="h-3 w-3 inline mx-1" /> button to stop running agents</span>
          </li>
          <li className="flex items-start gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground mt-2 flex-shrink-0" />
            <span>Wait for an agent to complete automatically</span>
          </li>
          <li className="flex items-start gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
            <div className="flex flex-wrap items-center gap-1">
              <button 
                onClick={handleUpgrade}
                className="text-primary hover:underline font-medium"
              >
                Upgrade your plan
              </button>
              <span>for more parallel runs</span>
            </div>
          </li>
        </ul>
      </div>
    </UpgradeDialog>
  );
};