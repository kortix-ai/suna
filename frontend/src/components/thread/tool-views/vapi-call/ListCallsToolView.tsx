import React from 'react';
import { Phone, Clock, ArrowUpRight, ArrowDownLeft, CheckCircle, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { extractListCallsData, formatPhoneNumber, formatDuration, statusConfig } from './_utils';
import { getToolTitle } from '../utils';

export function ListCallsToolView({
  name = 'list-calls',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const callsData = extractListCallsData(toolContent);
  const toolTitle = getToolTitle(name);

  if (!callsData) {
    return <div className="text-sm text-muted-foreground">No calls data available</div>;
  }

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-indigo-500/20 to-indigo-600/10 border border-indigo-500/20">
              <Phone className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
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
              className={
                isSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {isSuccess ? (
                <>
                  <CheckCircle className="h-3.5 w-3.5 mr-1" />
                  {callsData.count} {callsData.count === 1 ? 'Call' : 'Calls'} Retrieved
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                  Failed to retrieve calls
                </>
              )}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-3">
        {assistantContent && (
          <div className="text-sm text-foreground mb-3">{assistantContent}</div>
        )}

        {callsData.calls.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-6">
            No calls found
          </div>
        ) : (
          <div className="space-y-2">
            {callsData.calls.map((call, idx) => {
              const statusInfo = statusConfig[call.status as keyof typeof statusConfig] || statusConfig.queued;
              const isOutbound = call.direction === 'outbound';

              return (
                <div
                  key={idx}
                  className="bg-muted/30 rounded-lg p-3 border border-border hover:border-primary/20 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2 flex-1">
                      <div className={cn(
                        "h-8 w-8 rounded-lg flex items-center justify-center flex-shrink-0",
                        isOutbound ? "bg-blue-500/10" : "bg-green-500/10"
                      )}>
                        {isOutbound ? (
                          <ArrowUpRight className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                        ) : (
                          <ArrowDownLeft className="h-4 w-4 text-green-600 dark:text-green-400" />
                        )}
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-foreground">
                            {formatPhoneNumber(call.phone_number)}
                          </span>
                          <Badge className={cn("text-xs", statusInfo.color)}>
                            {statusInfo.label}
                          </Badge>
                        </div>
                        
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDuration(call.duration_seconds)}
                          </div>
                          {call.started_at && (
                            <span>
                              {new Date(call.started_at).toLocaleString()}
                            </span>
                          )}
                        </div>

                        <div className="text-xs font-mono text-muted-foreground mt-1 truncate">
                          {call.call_id}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {callsData.message && (
          <div className="text-xs text-muted-foreground pt-2 border-t border-border">
            {callsData.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

