import React from 'react';
import {
  Users,
  CheckCircle,
  AlertTriangle,
  Bot,
  Crown,
  Compass,
  Calendar,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LoadingState } from '../shared/LoadingState';
import { extractListAccountWorkersData } from './_utils';

export function ListAccountWorkersToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  if (!toolCall) {
    console.warn('ListAccountWorkersToolView: toolCall is undefined.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  const {
    search,
    include_kortix,
    message,
    workers,
    total,
    errorMessage,
    actualIsSuccess,
  } = extractListAccountWorkersData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp,
  );

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700">
              <Users className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
              {(search || include_kortix) && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {search ? `Filter: "${search}"` : 'Showing all workers'}
                  {include_kortix ? ' (including Kortix)' : ''}
                </p>
              )}
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="outline"
              className={cn(
                'text-xs font-medium',
                actualIsSuccess
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800'
                  : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800',
              )}
            >
              {actualIsSuccess ? <CheckCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              {total} {total === 1 ? 'worker' : 'workers'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Users}
            iconColor="text-zinc-500 dark:text-zinc-400"
            bgColor="bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60 dark:shadow-zinc-950/20"
            title="Loading account workers"
            showProgress={true}
          />
        ) : actualIsSuccess ? (
          workers.length > 0 ? (
            <ScrollArea className="h-full w-full">
              <div className="p-4 space-y-3">
                {workers.map((worker, index) => (
                  <div key={`${worker.agent_id}-${index}`} className="border rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center flex-shrink-0">
                          <Bot className="w-5 h-5 text-zinc-600 dark:text-zinc-400" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                            {worker.name || 'Untitled Worker'}
                          </h3>
                          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400 break-all">
                            {worker.agent_id}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        {worker.is_current && (
                          <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800">
                            <Compass className="w-3 h-3 mr-1" />
                            Current
                          </Badge>
                        )}
                        {worker.is_default && (
                          <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-800">
                            <Crown className="w-3 h-3 mr-1" />
                            Default
                          </Badge>
                        )}
                        {worker.is_kortix && (
                          <Badge variant="outline" className="text-xs">
                            Kortix
                          </Badge>
                        )}
                      </div>
                    </div>

                    {worker.created_at && (
                      <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <Calendar className="w-3 h-3" />
                        Created {formatTimestamp(worker.created_at)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex flex-col items-center justify-center h-full py-8 px-6">
              <div className="text-center w-full max-w-xs">
                <div className="w-16 h-16 rounded-xl mx-auto mb-4 flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                  <Users className="h-8 w-8 text-zinc-400" />
                </div>
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                  No workers found
                </h3>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {message || 'No workers available in this account.'}
                </p>
              </div>
            </div>
          )
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {errorMessage || 'Failed to list account workers.'}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
