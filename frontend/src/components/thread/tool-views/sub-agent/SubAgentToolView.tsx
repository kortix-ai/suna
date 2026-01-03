import React, { useState, useEffect, useMemo, useRef } from "react";
import { 
  Users, 
  CheckCircle, 
  AlertTriangle, 
  Clock, 
  Loader2, 
  ChevronRight, 
  XCircle,
  ExternalLink,
  Circle,
  GitBranch
} from "lucide-react";
import { cn } from "@/lib/utils";
import { 
  extractSpawnData, 
  extractListData, 
  extractResultData,
  getStatusColor,
  type SubAgentInfo,
  type SubAgentSpawnData,
  type SubAgentListData,
  type SubAgentResultData
} from "./_utils";
import { getToolTitle } from "../utils";
import type { ToolViewProps } from "../types";
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { UnifiedMarkdown } from '@/components/markdown';
import Link from "next/link";

/**
 * Parse streaming JSON to extract task/context during streaming
 */
function parseStreamingArgs(rawArgs: string | undefined): { task?: string; context?: string } {
  if (!rawArgs) return {};
  
  try {
    const parsed = JSON.parse(rawArgs);
    return {
      task: parsed.task,
      context: parsed.context
    };
  } catch {
    // Partial JSON - try to extract task and context with regex
    const taskMatch = rawArgs.match(/"task"\s*:\s*"([^"]*)/);
    const contextMatch = rawArgs.match(/"context"\s*:\s*"([^"]*)/);
    
    return {
      task: taskMatch?.[1]?.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
      context: contextMatch?.[1]?.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    };
  }
}

/**
 * Status icon component
 */
const StatusIcon: React.FC<{ status: string; className?: string }> = ({ status, className }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle className={cn("h-4 w-4 text-green-500", className)} />;
    case 'running':
    case 'spawned':
    case 'pending':
      return <Loader2 className={cn("h-4 w-4 text-blue-500 animate-spin", className)} />;
    case 'failed':
    case 'stopped':
      return <XCircle className={cn("h-4 w-4 text-red-500", className)} />;
    default:
      return <Circle className={cn("h-4 w-4 text-zinc-400", className)} />;
  }
};

/**
 * Individual sub-agent card (for list view)
 */
const SubAgentCard: React.FC<{ agent: SubAgentInfo; projectId?: string }> = ({ agent, projectId }) => {
  const linkHref = projectId && agent.thread_id 
    ? `/projects/${projectId}?threadId=${agent.thread_id}` 
    : null;

  const cardContent = (
    <div className={cn(
      "flex items-center gap-3 py-3 px-4 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/50 transition-colors border-b border-zinc-100 dark:border-zinc-800 last:border-b-0",
      linkHref && "cursor-pointer"
    )}>
      <StatusIcon status={agent.status} />
      
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-900 dark:text-zinc-100 line-clamp-2">
          {agent.task}
        </p>
        {agent.error && (
          <p className="text-xs text-red-500 mt-1 line-clamp-1">
            Error: {agent.error}
          </p>
        )}
      </div>
      
      <div className="flex items-center gap-2">
        <Badge variant="outline" className={cn("text-xs h-5 px-2 py-0", getStatusColor(agent.status))}>
          {agent.status}
        </Badge>
        {linkHref && <ChevronRight className="h-4 w-4 text-zinc-400" />}
      </div>
    </div>
  );

  if (linkHref) {
    return <Link href={linkHref}>{cardContent}</Link>;
  }
  
  return cardContent;
};

/**
 * Spawn sub-agent view - file streaming style with markdown
 */
const SpawnView: React.FC<{ 
  data: SubAgentSpawnData | null;
  streamingArgs: { task?: string; context?: string };
  isStreaming: boolean; 
  projectId?: string;
  context?: string;
}> = ({ data, streamingArgs, isStreaming, projectId, context }) => {
  // Use streaming args if available, otherwise fall back to parsed data
  const displayTask = streamingArgs.task || data?.task || '';
  const displayContext = streamingArgs.context || context || '';
  
  const linkHref = projectId && data?.thread_id 
    ? `/projects/${projectId}?threadId=${data.thread_id}` 
    : null;

  const isSpawning = isStreaming || data?.status === 'spawning' || !data?.sub_agent_id;
  const hasThreadId = data?.thread_id && data.thread_id.length > 0;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950">
      {/* File-like header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <GitBranch className="h-4 w-4 text-indigo-500 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 truncate">
            {hasThreadId ? `sub-agent-${data?.sub_agent_id?.slice(0, 8)}` : 'spawning...'}
          </span>
          <Badge 
            variant="outline" 
            className={cn(
              "text-[10px] h-4 px-1.5 ml-auto flex-shrink-0",
              isSpawning 
                ? "bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800" 
                : "bg-green-50 text-green-600 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800"
            )}
          >
            {isSpawning ? (
              <>
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                spawning
              </>
            ) : (
              <>
                <CheckCircle className="h-2.5 w-2.5 mr-1" />
                spawned
              </>
            )}
          </Badge>
        </div>
        {linkHref && !isSpawning && (
          <Link 
            href={linkHref}
            className="ml-2 p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
            title="Open sub-agent thread"
          >
            <ExternalLink className="h-3.5 w-3.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300" />
          </Link>
        )}
      </div>

      {/* Content area - markdown rendered task */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Task section */}
          <div className="mb-4">
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
              Task
            </div>
            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
              {displayTask ? (
                <>
                  <UnifiedMarkdown 
                    content={displayTask} 
                    className="text-sm text-zinc-800 dark:text-zinc-200 prose-sm prose-zinc dark:prose-invert max-w-none" 
                  />
                  {isSpawning && (
                    <span className="inline-block h-4 w-0.5 bg-indigo-500 ml-0.5 -mb-1 animate-pulse" />
                  )}
                </>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Receiving task...</span>
                </div>
              )}
            </div>
          </div>

          {/* Context section (if provided) */}
          {displayContext && (
            <div>
              <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
                Context
              </div>
              <div className="bg-zinc-50/50 dark:bg-zinc-900/50 rounded-lg border border-zinc-100 dark:border-zinc-800/50 p-3">
                <UnifiedMarkdown 
                  content={displayContext} 
                  className="text-xs text-zinc-600 dark:text-zinc-400 prose-xs prose-zinc dark:prose-invert max-w-none" 
                />
                {isSpawning && displayContext && (
                  <span className="inline-block h-3 w-0.5 bg-indigo-400 ml-0.5 -mb-0.5 animate-pulse" />
                )}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

/**
 * List view - shows multiple sub-agents
 */
const ListView: React.FC<{ data: SubAgentListData; projectId?: string }> = ({ data, projectId }) => {
  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {data.sub_agents.length === 0 ? (
        <div className="py-8 text-center">
          <Users className="h-10 w-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">{data.message || 'No sub-agents spawned yet'}</p>
        </div>
      ) : (
        data.sub_agents.map((agent) => (
          <SubAgentCard key={agent.sub_agent_id} agent={agent} projectId={projectId} />
        ))
      )}
    </div>
  );
};

/**
 * Result view - shows completed sub-agent result with markdown
 */
const ResultView: React.FC<{ data: SubAgentResultData }> = ({ data }) => {
  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusIcon status={data.status} className="flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 truncate">
            {data.task.slice(0, 50)}{data.task.length > 50 ? '...' : ''}
          </span>
        </div>
        <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", getStatusColor(data.status))}>
          {data.status}
        </Badge>
      </div>

      {/* Result content */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {data.error ? (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <div className="text-[11px] font-medium text-red-600 dark:text-red-400 uppercase tracking-wider mb-1">
                Error
              </div>
              <p className="text-sm text-red-700 dark:text-red-300">{data.error}</p>
            </div>
          ) : (
            <div>
              <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
                Result
              </div>
              <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                <UnifiedMarkdown 
                  content={data.result} 
                  className="text-sm text-zinc-800 dark:text-zinc-200 prose-sm prose-zinc dark:prose-invert max-w-none" 
                />
              </div>
            </div>
          )}
          
          {data.completed_at && (
            <div className="mt-3 text-[10px] text-zinc-400 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Completed: {new Date(data.completed_at).toLocaleString()}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

/**
 * Main Sub-Agent Tool View Component
 */
export const SubAgentToolView: React.FC<ToolViewProps> = ({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  streamingText
}) => {
  const functionName = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(functionName);
  const args = toolCall.arguments || {};
  
  // Get streaming content from rawArguments or streamingText
  const rawStreamingSource = toolCall.rawArguments || streamingText;
  
  // Throttle streaming updates for performance
  const [throttledStreamingSource, setThrottledStreamingSource] = useState(rawStreamingSource);
  const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);
  
  useEffect(() => {
    if (!isStreaming) {
      setThrottledStreamingSource(rawStreamingSource);
      return;
    }
    
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateRef.current;
    const THROTTLE_MS = 50; // Update every 50ms max
    
    if (timeSinceLastUpdate >= THROTTLE_MS) {
      setThrottledStreamingSource(rawStreamingSource);
      lastUpdateRef.current = now;
    } else {
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
      }
      throttleTimeoutRef.current = setTimeout(() => {
        setThrottledStreamingSource(rawStreamingSource);
        lastUpdateRef.current = Date.now();
      }, THROTTLE_MS - timeSinceLastUpdate);
    }
    
    return () => {
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
      }
    };
  }, [rawStreamingSource, isStreaming]);
  
  // Parse streaming args for spawn_sub_agent
  const streamingArgs = useMemo(() => {
    if (functionName === 'spawn-sub-agent' && isStreaming && throttledStreamingSource) {
      return parseStreamingArgs(throttledStreamingSource);
    }
    return {};
  }, [functionName, isStreaming, throttledStreamingSource]);
  
  // Extract data based on function type
  const spawnData = functionName === 'spawn-sub-agent' 
    ? extractSpawnData(toolCall.arguments, toolResult?.output)
    : null;
  
  const listData = (functionName === 'list-sub-agents' || functionName === 'wait-for-sub-agents')
    ? extractListData(toolCall.arguments, toolResult?.output)
    : null;
  
  const resultData = functionName === 'get-sub-agent-result'
    ? extractResultData(toolCall.arguments, toolResult?.output)
    : null;

  // For spawn, show content even during streaming if we have streaming args
  const hasSpawnContent = spawnData || (functionName === 'spawn-sub-agent' && (streamingArgs.task || args.task));
  const hasData = hasSpawnContent || listData || resultData;
  
  // Status summary for header
  const statusSummary = listData?.status_summary || {};
  const completedCount = statusSummary['completed'] || 0;
  const runningCount = (statusSummary['running'] || 0) + (statusSummary['pending'] || 0) + (statusSummary['spawned'] || 0);
  const failedCount = (statusSummary['failed'] || 0) + (statusSummary['stopped'] || 0);

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-600/10 border border-indigo-500/20">
              <Users className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <div className="flex items-center gap-2">
              {listData && (
                <>
                  {runningCount > 0 && (
                    <Badge variant="outline" className="text-xs font-normal bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800">
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      {runningCount} running
                    </Badge>
                  )}
                  {completedCount > 0 && (
                    <Badge variant="outline" className="text-xs font-normal bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border-green-200 dark:border-green-800">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {completedCount} done
                    </Badge>
                  )}
                  {failedCount > 0 && (
                    <Badge variant="outline" className="text-xs font-normal bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800">
                      <XCircle className="h-3 w-3 mr-1" />
                      {failedCount} failed
                    </Badge>
                  )}
                </>
              )}
              <Badge
                variant="secondary"
                className={
                  isSuccess
                    ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                    : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
                }
              >
                {isSuccess ? (
                  <CheckCircle className="h-3.5 w-3.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && !hasData ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-indigo-100 to-indigo-50 shadow-inner dark:from-indigo-800/40 dark:to-indigo-900/60">
              <Loader2 className="h-10 w-10 text-indigo-500 dark:text-indigo-400 animate-spin" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Processing
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {functionName === 'spawn-sub-agent' ? 'Spawning sub-agent...' : 'Loading sub-agents...'}
            </p>
          </div>
        ) : hasData ? (
          <>
            {(hasSpawnContent && functionName === 'spawn-sub-agent') && (
              <SpawnView 
                data={spawnData}
                streamingArgs={streamingArgs}
                isStreaming={isStreaming} 
                projectId={project?.project_id}
                context={args.context}
              />
            )}
            {listData && (
              <ScrollArea className="h-full w-full">
                <ListView data={listData} projectId={project?.project_id} />
              </ScrollArea>
            )}
            {resultData && <ResultView data={resultData} />}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <Users className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Data
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Sub-agent information will appear here
            </p>
          </div>
        )}
      </CardContent>
      
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {listData && listData.total > 0 && (
            <Badge variant="outline" className="h-6 py-0.5">
              <Users className="h-3 w-3 mr-1" />
              {listData.total} sub-agents
            </Badge>
          )}
          {listData?.timed_out && (
            <Badge variant="outline" className="h-6 py-0.5 text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-700">
              <Clock className="h-3 w-3 mr-1" />
              Timed out
            </Badge>
          )}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {toolTimestamp && !isStreaming
            ? new Date(toolTimestamp).toLocaleTimeString()
            : assistantTimestamp
              ? new Date(assistantTimestamp).toLocaleTimeString()
              : ''}
        </div>
      </div>
    </Card>
  );
};

export default SubAgentToolView;
