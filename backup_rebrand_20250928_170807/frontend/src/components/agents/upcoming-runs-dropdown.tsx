"use client";

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu';
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Clock, Calendar, ChevronDown, Activity, Zap, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useAgentUpcomingRuns, type UpcomingRun } from '@/hooks/react-query/agents/use-agent-upcoming-runs';
import { formatDistanceToNow, parseISO } from 'date-fns';

interface UpcomingRunsDropdownProps {
  agentId: string;
}

interface RunItemProps {
  run: UpcomingRun;
}

const RunItem: React.FC<RunItemProps> = ({ run }) => {
  const nextRunTime = parseISO(run.next_run_time_local);
  const timeUntilRun = formatDistanceToNow(nextRunTime, { addSuffix: true });
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem className="flex flex-col items-start p-3 cursor-pointer hover:bg-accent/80">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center space-x-2">
                <div className="p-1 bg-primary/10 rounded-lg">
                  <Clock className="h-3 w-3 text-primary" />
                </div>
                <span className="font-medium text-sm truncate max-w-32">
                  {run.trigger_name}
                </span>
              </div>
              <Badge variant="outline" className="text-xs">
                {run.execution_type}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              {timeUntilRun}
            </div>
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-80 p-4">
          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Activity className="h-4 w-4 text-primary" />
              <span className="font-semibold">{run.trigger_name}</span>
            </div>
            
            <div className="space-y-2 text-sm">
              <div className="flex items-center space-x-2">
                <Clock className="h-3 w-3" />
                <span>{run.human_readable}</span>
              </div>
              
              <div className="flex items-center space-x-2">
                <Calendar className="h-3 w-3" />
                <span>Next run: {nextRunTime.toLocaleString()}</span>
              </div>
              
              <div className="flex items-center space-x-2">
                <Zap className="h-3 w-3" />
                <span>Type: {run.execution_type}</span>
              </div>
              
              {run.agent_prompt && (
                <div className="mt-2 p-2 bg-muted/50 rounded text-xs">
                  <strong>Prompt:</strong> {run.agent_prompt.substring(0, 100)}
                  {run.agent_prompt.length > 100 && '...'}
                </div>
              )}
              
              {run.workflow_id && (
                <div className="mt-2 p-2 bg-muted/50 rounded text-xs">
                  <strong>Workflow:</strong> {run.workflow_id}
                </div>
              )}
              
              <div className="text-xs text-muted-foreground mt-2">
                Timezone: {run.timezone}
              </div>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export const UpcomingRunsDropdown: React.FC<UpcomingRunsDropdownProps> = ({ agentId }) => {
  const { data: upcomingRuns, isLoading, error } = useAgentUpcomingRuns(agentId, 5);
  const [isOpen, setIsOpen] = useState(false);
  const hasRuns = upcomingRuns?.upcoming_runs?.length > 0;
  return (
    <TooltipProvider>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button 
                variant="ghost" 
                size="icon"
                className="h-9 w-9"
              >
                <div className="relative">
                  <Clock className="h-4 w-4" />
                  {hasRuns && (
                    <div className="absolute -top-1 -right-1 h-2 w-2 bg-green-500 rounded-full animate-pulse" />
                  )}
                </div>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p>Upcoming Runs</p>
          </TooltipContent>
        </Tooltip>
      
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="flex items-center space-x-2">
          <Clock className="h-4 w-4" />
          <span>Upcoming Runs</span>
        </DropdownMenuLabel>
        
        <DropdownMenuSeparator />
        
        {isLoading && (
          <DropdownMenuItem disabled className="flex items-center justify-center py-4">
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
              <span>Loading...</span>
            </div>
          </DropdownMenuItem>
        )}
        
        {error && (
          <DropdownMenuItem disabled className="flex items-center justify-center py-4">
            <div className="flex items-center space-x-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>Failed to load runs</span>
            </div>
          </DropdownMenuItem>
        )}
        
        {!isLoading && !error && !hasRuns && (
          <DropdownMenuItem disabled className="flex items-center justify-center py-4">
            <div className="flex flex-col items-center text-muted-foreground">
              <Clock className="h-6 w-6" />
              <span className="text-sm">No upcoming runs</span>
              <span className="text-xs text-center">
                Create a schedule trigger to see upcoming runs
              </span>
            </div>
          </DropdownMenuItem>
        )}
        
        {hasRuns && upcomingRuns.upcoming_runs.map((run) => (
          <RunItem key={run.trigger_id} run={run} />
        ))}
        
        {hasRuns && upcomingRuns.total_count > 5 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-center text-sm text-muted-foreground">
              Showing 5 of {upcomingRuns.total_count} upcoming runs
            </DropdownMenuItem>
          </>
        )}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}; 