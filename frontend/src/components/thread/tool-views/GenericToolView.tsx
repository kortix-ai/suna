'use client'

import React from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Clock,
  Wrench,
  Copy,
  Check,
  Loader2,
} from 'lucide-react';
import { ToolViewProps } from './types';
import { formatTimestamp, getToolTitle } from './utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from '@/components/ui/button';
import { LoadingState } from './shared/LoadingState';
import { toast } from 'sonner';

export function GenericToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // All hooks must be called unconditionally at the top
  const [isCopyingInput, setIsCopyingInput] = React.useState(false);
  const [isCopyingOutput, setIsCopyingOutput] = React.useState(false);

  const hasInput = toolCall?.arguments && Object.keys(toolCall.arguments).length > 0;
  const hasOutput = toolResult?.output !== undefined && toolResult?.output !== null;

  // Copy functions
  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied to clipboard');
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      toast.error('Failed to copy');
      return false;
    }
  }, []);

  const handleCopyInput = React.useCallback(async () => {
    if (!toolCall?.arguments) return;
    setIsCopyingInput(true);
    await copyToClipboard(JSON.stringify(toolCall.arguments, null, 2));
    setTimeout(() => setIsCopyingInput(false), 2000);
  }, [toolCall?.arguments, copyToClipboard]);

  const handleCopyOutput = React.useCallback(async () => {
    if (!toolResult?.output) return;
    setIsCopyingOutput(true);
    const outputText = typeof toolResult.output === 'string' 
      ? toolResult.output 
      : JSON.stringify(toolResult.output, null, 2);
    await copyToClipboard(outputText);
    setTimeout(() => setIsCopyingOutput(false), 2000);
  }, [toolResult?.output, copyToClipboard]);

  // Defensive check - handle cases where toolCall might be undefined or missing function_name
  if (!toolCall || !toolCall.function_name) {
    console.warn('GenericToolView: toolCall is undefined or missing function_name. Tool views should use structured props.');
    return (
      <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4">
          <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            Tool View Error
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            This tool view requires structured metadata. Please update the component to use toolCall and toolResult props.
          </p>
        </CardContent>
      </Card>
    );
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20">
              <Wrench className="w-5 h-5 text-orange-500 dark:text-orange-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <div className={`h-6 w-6 rounded-full flex items-center justify-center ${
              actualIsSuccess
                ? "bg-emerald-100 dark:bg-emerald-900/60"
                : "bg-rose-100 dark:bg-rose-900/60"
            }`}>
              {actualIsSuccess ? (
                <CheckCircle className={`h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300`} />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-rose-700 dark:text-rose-300" />
              )}
            </div>
          )}

          {isStreaming && (
            <div className="h-6 w-6 rounded-full flex items-center justify-center bg-blue-100 dark:bg-blue-900/60">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700 dark:text-blue-300" />
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Wrench}
            iconColor="text-orange-500 dark:text-orange-400"
            bgColor="bg-gradient-to-b from-orange-100 to-orange-50 shadow-inner dark:from-orange-800/40 dark:to-orange-900/60 dark:shadow-orange-950/20"
            title="Executing tool"
            filePath={name}
            showProgress={true}
          />
        ) : hasInput || hasOutput ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              {hasInput && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                      Input
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyInput}
                      disabled={isCopyingInput}
                      className="h-6 w-6 p-0"
                      title="Copy input"
                    >
                      {isCopyingInput ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="p-4">
                      <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                        {JSON.stringify(toolCall.arguments, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              )}

              {hasOutput && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                      Output
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyOutput}
                      disabled={isCopyingOutput}
                      className="h-6 w-6 p-0"
                      title="Copy output"
                    >
                      {isCopyingOutput ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="p-4">
                      <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                        {typeof toolResult.output === 'string' 
                          ? toolResult.output 
                          : JSON.stringify(toolResult.output, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <Wrench className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Content Available
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              This tool execution did not produce any input or output content to display.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && (hasInput || hasOutput) && (
            <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
              <Wrench className="h-3 w-3" />
              Tool
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5" />
          {toolTimestamp && !isStreaming
            ? formatTimestamp(toolTimestamp)
            : assistantTimestamp
              ? formatTimestamp(assistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}
