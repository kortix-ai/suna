import React from 'react';
import { PhoneOff, CheckCircle, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { extractEndCallData } from './_utils';
import { getToolTitle } from '../utils';

export function EndCallToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // Defensive check - ensure toolCall is defined
  if (!toolCall) {
    console.warn('EndCallToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);
  const callData = extractEndCallData(toolResult);

  if (!callData) {
    return <div className="text-sm text-muted-foreground">No end call data available</div>;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={PhoneOff} title={toolTitle} />
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-3">

        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Call ID</div>
          <div className="text-sm font-mono text-foreground bg-muted/50 rounded p-2 border border-border">
            {callData.call_id}
          </div>
        </div>

        {callData.message && (
          <div className="text-sm text-muted-foreground bg-zinc-500/10 rounded-lg p-3 border border-zinc-500/20">
            {callData.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

