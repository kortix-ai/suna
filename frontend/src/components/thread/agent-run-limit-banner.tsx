'use client';

import React, { useEffect } from 'react';
import { AlertTriangle, ExternalLink, Square, Loader2, Zap, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import Link from 'next/link';
import { useStopAgentMutation } from '@/hooks/threads/use-agent-run';
import { AgentRun, getAgentRuns } from '@/lib/api/agents';
import { toast } from 'sonner';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { getThread } from '@/hooks/threads/utils';
import { getProject } from '@/lib/api/threads';
import { threadKeys } from '@/hooks/threads/keys';
import { usePricingModalStore } from '@/stores/pricing-modal-store';

interface RunningAgentInfo {
  threadId: string;
  projectId: string | null;
  projectName: string;
  agentRun: AgentRun | null;
  isLoading: boolean;
}

interface AgentRunLimitBannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runningCount: number;
  runningThreadIds: string[];
}

export const AgentRunLimitBanner: React.FC<AgentRunLimitBannerProps> = ({
  open,
  onOpenChange,
  runningCount,
  runningThreadIds,
}) => {
  const pricingModalStore = usePricingModalStore();
  const stopAgentMutation = useStopAgentMutation();
  const queryClient = useQueryClient();

  // Debug logging
  useEffect(() => {
    if (open) {
      console.log('AgentRunLimitBanner: Dialog opened', { runningCount, runningThreadIds });
    }
  }, [open, runningCount, runningThreadIds]);

  // Fetch thread, agent run, and project data for running threads
  const threadQueries = useQueries({
    queries: runningThreadIds.slice(0, 3).map(threadId => ({
      queryKey: threadKeys.details(threadId),
      queryFn: () => getThread(threadId),
      enabled: open && !!threadId,
      retry: 1,
      staleTime: 30000,
    }))
  });

  const agentRunQueries = useQueries({
    queries: runningThreadIds.slice(0, 3).map(threadId => ({
      queryKey: threadKeys.agentRuns(threadId),
      queryFn: () => getAgentRuns(threadId),
      enabled: open && !!threadId,
      retry: 1,
      staleTime: 30000,
    }))
  });

  const projectQueries = useQueries({
    queries: runningThreadIds.slice(0, 3).map((threadId, index) => {
      const threadQuery = threadQueries[index];
      const projectId = threadQuery?.data?.project_id;
      return {
        queryKey: threadKeys.project(projectId || ""),
        queryFn: () => projectId ? getProject(projectId) : null,
        enabled: open && !!projectId,
        retry: 1,
        staleTime: 30000,
      };
    })
  });

  const runningAgentsInfo: RunningAgentInfo[] = React.useMemo(() => {
    return runningThreadIds.slice(0, 3).map((threadId, index) => {
      const threadQuery = threadQueries[index];
      const agentRunQuery = agentRunQueries[index];
      const projectQuery = projectQueries[index];
      
      const isLoading = threadQuery?.isLoading || agentRunQuery?.isLoading || projectQuery?.isLoading;
      const runningAgentRun = agentRunQuery?.data?.find((run: AgentRun) => run.status === 'running') || null;
      const projectId = threadQuery?.data?.project_id || null;
      const projectName = projectQuery?.data?.name || '';

      return {
        threadId,
        projectId,
        projectName,
        agentRun: runningAgentRun,
        isLoading: isLoading || false,
      };
    });
  }, [runningThreadIds, threadQueries, agentRunQueries, projectQueries]);

  const handleStopAgent = async (agentRunId: string, threadId: string) => {
    try {
      await stopAgentMutation.mutateAsync(agentRunId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: threadKeys.agentRuns(threadId) }),
        queryClient.invalidateQueries({ queryKey: threadKeys.details(threadId) }),
        queryClient.invalidateQueries({ queryKey: ['active-agent-runs'] }),
      ]);
      toast.success('Worker stopped — you can now send your message');
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to stop agent:', error);
      toast.error('Failed to stop Worker');
    }
  };

  const handleUpgrade = () => {
    onOpenChange(false);
    pricingModalStore.openPricingModal({
      title: 'Upgrade to run multiple workers in parallel',
      alertTitle: 'Concurrent Run Limit Reached',
      alertSubtitle: `Your current plan allows ${runningCount === 1 ? '1 worker' : `${runningCount} workers`} running at a time. Upgrade to run more in parallel.`,
    });
  };

  const isAnyLoading = runningAgentsInfo.some(info => info.isLoading);
  const firstRunningAgent = runningAgentsInfo[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted">
              <AlertTriangle className="h-5 w-5 text-foreground" />
            </div>
            <div className="flex-1">
              <DialogTitle className="text-lg font-semibold">
                Worker Already Running
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground mt-1">
                Your plan allows 1 concurrent worker at a time
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* Running agent info */}
          {isAnyLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading active worker...</span>
            </div>
          ) : firstRunningAgent?.agentRun ? (
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="relative flex-shrink-0">
                    <div className="h-2.5 w-2.5 rounded-full bg-foreground" />
                    <div className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-foreground animate-ping opacity-20" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate text-foreground">
                      {firstRunningAgent.projectName || 'Active Project'}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      Running since {new Date(firstRunningAgent.agentRun.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
                
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={() => handleStopAgent(firstRunningAgent.agentRun!.id, firstRunningAgent.threadId)}
                        disabled={stopAgentMutation.isPending}
                      >
                        {stopAgentMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Square className="h-3 w-3" />
                        )}
                        Stop
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Stop this worker to start a new one</TooltipContent>
                  </Tooltip>
                  
                  {firstRunningAgent.projectId && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                        >
                          <Link 
                            href={`/projects/${firstRunningAgent.projectId}/thread/${firstRunningAgent.threadId}`}
                            target="_blank"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span className="sr-only">View running worker</span>
                          </Link>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Open in new tab</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground text-center">
                {runningCount} worker{runningCount > 1 ? 's' : ''} running in the background
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-2">
            <Button
              onClick={handleUpgrade}
              className="w-full"
            >
              <Zap className="h-4 w-4 mr-2" />
              Upgrade for Parallel Runs
            </Button>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="w-full"
            >
              Got it
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
