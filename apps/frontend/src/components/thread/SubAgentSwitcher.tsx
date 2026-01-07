'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Users,
  ChevronDown,
  ArrowLeft,
  CheckCircle,
  Loader2,
  XCircle,
  Circle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  useSubAgentThreads,
  useParentThread,
  type SubAgentThread
} from '@/hooks/threads/use-sub-agents';

interface SubAgentSwitcherProps {
  threadId: string;
  projectId: string;
  className?: string;
}

/**
 * Status icon for sub-agent
 */
const StatusIcon: React.FC<{ status?: string; className?: string }> = ({ status, className }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle className={cn("h-3.5 w-3.5 text-green-500", className)} />;
    case 'running':
    case 'pending':
      return <Loader2 className={cn("h-3.5 w-3.5 text-blue-500 animate-spin", className)} />;
    case 'failed':
    case 'stopped':
      return <XCircle className={cn("h-3.5 w-3.5 text-red-500", className)} />;
    default:
      return <Circle className={cn("h-3.5 w-3.5 text-zinc-400", className)} />;
  }
};

/**
 * Get status badge color
 */
function getStatusColor(status?: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800';
    case 'running':
    case 'pending':
      return 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800';
    case 'failed':
    case 'stopped':
      return 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800';
    default:
      return 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:border-zinc-700';
  }
}

/**
 * Sub-agent item in dropdown
 */
const SubAgentItem: React.FC<{
  agent: SubAgentThread;
  projectId: string;
  isCurrent: boolean;
}> = ({ agent, projectId, isCurrent }) => {
  const taskDescription = agent.latest_run?.metadata?.task_description || agent.name || 'Sub-agent';
  const displayName = taskDescription.length > 40
    ? taskDescription.slice(0, 40) + '...'
    : taskDescription;

  return (
    <DropdownMenuItem asChild disabled={isCurrent}>
      <Link
        href={`/projects/${projectId}/thread/${agent.thread_id}`}
        className={cn(
          "flex items-center gap-3 py-2 cursor-pointer",
          isCurrent && "bg-muted"
        )}
      >
        <StatusIcon status={agent.latest_run?.status} />
        <div className="flex-1 min-w-0">
          <span className="text-sm truncate block">{displayName}</span>
        </div>
        <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", getStatusColor(agent.latest_run?.status))}>
          {agent.latest_run?.status || 'unknown'}
        </Badge>
      </Link>
    </DropdownMenuItem>
  );
};

/**
 * SubAgentSwitcher - Shows dropdown to switch between main thread and sub-agent threads
 * 
 * Appears when:
 * 1. Current thread has sub-agents (shows dropdown to view them)
 * 2. Current thread IS a sub-agent (shows "Back to main" button)
 */
export function SubAgentSwitcher({ threadId, projectId, className }: SubAgentSwitcherProps) {
  const router = useRouter();

  // Check if this thread has sub-agents
  const { data: subAgents = [], isLoading: isLoadingSubAgents } = useSubAgentThreads(threadId);

  // Check if this thread IS a sub-agent (has a parent)
  const { data: parentThread, isLoading: isLoadingParent } = useParentThread(threadId);

  const hasSubAgents = subAgents.length > 0;
  const isSubAgent = !!parentThread;

  // Don't render if neither condition is met
  if (!hasSubAgents && !isSubAgent && !isLoadingSubAgents && !isLoadingParent) {
    return null;
  }

  // Loading state
  if (isLoadingSubAgents || isLoadingParent) {
    return null; // Don't show anything while loading to avoid flicker
  }

  // If this is a sub-agent, show "Back to main thread" button
  if (isSubAgent && parentThread) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn("h-8 gap-2", className)}
        onClick={() => router.push(`/projects/${parentThread.project_id}/thread/${parentThread.thread_id}`)}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="text-xs">Back to main</span>
      </Button>
    );
  }

  // If this thread has sub-agents, show dropdown
  if (hasSubAgents) {
    const runningCount = subAgents.filter(a =>
      a.latest_run?.status === 'running' || a.latest_run?.status === 'pending'
    ).length;
    const completedCount = subAgents.filter(a => a.latest_run?.status === 'completed').length;
    const failedCount = subAgents.filter(a =>
      a.latest_run?.status === 'failed' || a.latest_run?.status === 'stopped'
    ).length;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn("h-8 gap-2", className)}
          >
            <Users className="h-3.5 w-3.5" />
            <span className="text-xs">Sub-agents</span>
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px] ml-1">
              {subAgents.length}
            </Badge>
            {runningCount > 0 && (
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            )}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>Sub-Agent Threads</span>
            <div className="flex items-center gap-1">
              {runningCount > 0 && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] bg-blue-50 dark:bg-blue-900/20">
                  <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                  {runningCount}
                </Badge>
              )}
              {completedCount > 0 && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] bg-green-50 dark:bg-green-900/20">
                  <CheckCircle className="h-2.5 w-2.5 mr-1" />
                  {completedCount}
                </Badge>
              )}
              {failedCount > 0 && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] bg-red-50 dark:bg-red-900/20">
                  <XCircle className="h-2.5 w-2.5 mr-1" />
                  {failedCount}
                </Badge>
              )}
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          <div className="max-h-64 overflow-y-auto">
            {subAgents.map(agent => (
              <SubAgentItem
                key={agent.thread_id}
                agent={agent}
                projectId={projectId}
                isCurrent={agent.thread_id === threadId}
              />
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return null;
}

export default SubAgentSwitcher;

