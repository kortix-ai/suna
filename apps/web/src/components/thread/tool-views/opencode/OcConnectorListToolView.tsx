'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Plug,
  Hash,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { parseConnectorListOutput, type ConnectorEntry } from '@/lib/utils/kortix-tool-output';
import { cn } from '@/lib/utils';

export function OcConnectorListToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const filter = (args.filter as string) || (ocState?.input?.filter as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const connectors = useMemo(() => parseConnectorListOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Loading connectors" subtitle="Fetching connector list..." />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Plug}
            title="Connector List"
            subtitle={filter ? `Filter: ${filter}` : `${connectors.length} connector${connectors.length !== 1 ? 's' : ''}`}
          />
          {connectors.length > 0 && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2">
              <Hash className="h-3 w-3 mr-1 opacity-70" />
              {connectors.length}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {connectors.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="divide-y divide-border/40">
              {connectors.map((conn: ConnectorEntry) => (
                <div key={conn.name} className="px-4 py-3 hover:bg-muted/20 transition-colors">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-foreground truncate flex-1">
                      {conn.name}
                    </span>
                    <Badge 
                      variant="outline" 
                      className={cn(
                        "h-4 py-0 text-[0.5625rem] font-normal capitalize",
                        conn.source === 'api-key' && 'border-amber-500/50 text-amber-600 dark:text-amber-400',
                        conn.source === 'cli' && 'border-gray-500/50 text-gray-600 dark:text-gray-400',
                        conn.source === 'channel' && 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
                        conn.source === 'custom' && 'border-purple-500/50 text-purple-600 dark:text-purple-400',
                        conn.source === 'file' && 'border-slate-500/50 text-slate-600 dark:text-slate-400',
                      )}
                    >
                      {conn.source}
                    </Badge>
                  </div>
                  {conn.description && (
                    <div className="text-[11px] text-muted-foreground/60">
                      {conn.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {output.slice(0, 3000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to list connectors'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Plug className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No connectors found</p>
            <p className="text-xs text-muted-foreground/50 mt-1">Use connector_setup to add services</p>
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
          ) : connectors.length > 0 ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              {connectors.length} connector{connectors.length !== 1 ? 's' : ''}
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
