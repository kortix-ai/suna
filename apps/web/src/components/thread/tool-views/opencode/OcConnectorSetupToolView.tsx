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
import { parseConnectorSetupOutput } from '@/lib/utils/kortix-tool-output';

export function OcConnectorSetupToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const data = useMemo(() => parseConnectorSetupOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Setting up connectors" subtitle="Configuring connectors..." />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={data?.success ? CheckCircle : Plug}
            title={data?.success ? 'Connectors Setup' : 'Connector Setup'}
            subtitle={data ? `${data.count} connector${data.count !== 1 ? 's' : ''} configured` : 'Setting up...'}
          />
          {data?.success && (
            <Badge variant="outline" className="h-6 py-0.5 flex-shrink-0 ml-2">
              Done
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {data?.connectors && data.connectors.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-3">
              {data.connectors.map((conn, i) => (
                <div key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-2xl border border-border/50 bg-foreground/[0.02]">
                  <Plug className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium text-foreground truncate tracking-tight">
                      {conn}
                    </div>
                  </div>
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 text-foreground/70" />
                </div>
              ))}
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
            <p className="text-sm">{output || 'Failed to setup connectors'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Plug className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Setting up connectors...</p>
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
          ) : data?.success ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              {data.count} configured
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}