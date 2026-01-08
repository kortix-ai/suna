import React from 'react';
import { Phone, Clock, ArrowUpRight, ArrowDownLeft, CheckCircle, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { cn } from '@/lib/utils';
import { extractListCallsData, formatPhoneNumber, formatDuration, statusConfig } from './_utils';
import { getToolTitle } from '../utils';

export function ListCallsToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // Defensive check - ensure toolCall is defined
  if (!toolCall) {
    console.warn('ListCallsToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);
  const callsData = extractListCallsData(toolResult);

  if (!callsData) {
    return <div className="text-sm text-muted-foreground">No calls data available</div>;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Phone} title={toolTitle} />
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-3">

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
                        "bg-zinc-500/10"
                      )}>
                        {isOutbound ? (
                          <ArrowUpRight className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                        ) : (
                          <ArrowDownLeft className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
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

