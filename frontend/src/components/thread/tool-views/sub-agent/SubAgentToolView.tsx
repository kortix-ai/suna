import type React from "react";
import { 
  Users, 
  CheckCircle, 
  AlertTriangle, 
  Clock, 
  Loader2, 
  ChevronRight, 
  XCircle,
  PlayCircle,
  Circle
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
import Link from "next/link";

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
 * Spawn sub-agent view - shows single spawned agent
 */
const SpawnView: React.FC<{ data: SubAgentSpawnData; isStreaming: boolean; projectId?: string }> = ({ 
  data, 
  isStreaming,
  projectId 
}) => {
  const linkHref = projectId && data.thread_id 
    ? `/projects/${projectId}?threadId=${data.thread_id}` 
    : null;

  return (
    <div className="p-4">
      <div className={cn(
        "rounded-lg border border-zinc-200 dark:border-zinc-700 p-4",
        "bg-gradient-to-br from-indigo-50/50 to-purple-50/50 dark:from-indigo-900/20 dark:to-purple-900/20"
      )}>
        <div className="flex items-start gap-3">
          <div className="relative p-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/50">
            {isStreaming || data.status === 'spawning' ? (
              <Loader2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400 animate-spin" />
            ) : (
              <PlayCircle className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            )}
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Sub-Agent Spawned
              </h4>
              <Badge variant="outline" className={cn("text-xs", getStatusColor(data.status))}>
                {data.status}
              </Badge>
            </div>
            
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
              {data.task}
            </p>
            
            {data.sub_agent_id && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">ID: {data.sub_agent_id.slice(0, 8)}...</span>
                {linkHref && (
                  <Link 
                    href={linkHref}
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
                  >
                    View thread <ChevronRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
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
 * Result view - shows completed sub-agent result
 */
const ResultView: React.FC<{ data: SubAgentResultData }> = ({ data }) => {
  return (
    <div className="p-4">
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        <div className="px-4 py-3 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusIcon status={data.status} />
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {data.task}
              </span>
            </div>
            <Badge variant="outline" className={cn("text-xs", getStatusColor(data.status))}>
              {data.status}
            </Badge>
          </div>
        </div>
        
        <div className="p-4 bg-white dark:bg-zinc-950">
          {data.error ? (
            <div className="text-sm text-red-600 dark:text-red-400">
              <strong>Error:</strong> {data.error}
            </div>
          ) : (
            <div className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
              {data.result}
            </div>
          )}
        </div>
        
        {data.completed_at && (
          <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-700 text-xs text-zinc-500">
            Completed: {new Date(data.completed_at).toLocaleString()}
          </div>
        )}
      </div>
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
  project
}) => {
  const functionName = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(functionName);
  
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

  const hasData = spawnData || listData || resultData;
  
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
          <ScrollArea className="h-full w-full">
            {spawnData && <SpawnView data={spawnData} isStreaming={isStreaming} projectId={project?.project_id} />}
            {listData && <ListView data={listData} projectId={project?.project_id} />}
            {resultData && <ResultView data={resultData} />}
          </ScrollArea>
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

