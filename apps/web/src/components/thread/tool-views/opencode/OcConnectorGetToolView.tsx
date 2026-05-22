'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Plug,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { parseConnectorGetOutput, type ConnectorGetData } from '@/lib/utils/kortix-tool-output';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '@/components/ui/status';

export function OcConnectorGetToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const connectorName = (args.name as string) || (ocState?.input?.name as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const data = useMemo(() => parseConnectorGetOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Loading connector" subtitle={connectorName || 'Fetching connector details...'} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Plug}
            title={data?.name ?? 'Connector'}
            subtitle={connectorName && connectorName !== data?.name ? connectorName : (data?.description || 'Details')}
          />
          {data && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2 capitalize">
              {data.source}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {data ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              {/* Description and source */}
              {data.description && (
                <div className="text-xs text-muted-foreground">
                  {data.description}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-6 py-0 capitalize">
                  {data.source}
                </Badge>
              </div>

              {/* Env keys */}
              {data.env && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Env:</span>
                  <code className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono">
                    {data.env}
                  </code>
                </div>
              )}

              {/* Notes */}
              {data.notes && (
                <div className="rounded-2xl border border-border/50 overflow-hidden">
                  <div className="px-3 py-2 bg-muted/30 border-b border-border/30 text-xs font-medium text-muted-foreground/70">
                    Notes
                  </div>
                  <div className="p-3 text-xs text-muted-foreground/80 whitespace-pre-wrap">
                    {data.notes}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap font-mono">
              {output.slice(0, 5000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to retrieve connector'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Plug className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No connector data</p>
          </div>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : data ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className={cn('h-3 w-3', STATUS_TEXT.success)} />
              Loaded
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
