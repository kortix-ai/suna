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
import { AppIcon } from './shared/AppIcon';
import { SmartJsonViewer } from './shared/SmartJsonViewer';

export function GenericToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const parseContent = React.useCallback((content: any): any => {
    if (!content) return null;

    if (typeof content === 'object') {
      return content;
    }

    if (typeof content === 'string') {
      const textContentMatch = content.match(/text=(['"])((?:(?!\1|\\).|\\.)*)\1/);
      
      if (textContentMatch) {
         try {
           let jsonStr = textContentMatch[2];
           if (textContentMatch[1] === "'") {
             jsonStr = jsonStr.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
           } else {
             jsonStr = jsonStr.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
           }
           
           try {
             return JSON.parse(jsonStr);
           } catch {
             return jsonStr;
           }
         } catch (e) {
         }
      }

      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'string') {
           try {
             return JSON.parse(parsed);
           } catch {
             return parsed;
           }
        }
        return parsed;
      } catch (e) {
      }
    }
    
    return content;
  }, []);

  // Format arguments from toolCall
  const parsedAssistantContent = React.useMemo(
    () => parseContent(toolCall?.arguments),
    [toolCall?.arguments, parseContent],
  );
  
  // Format output from toolResult
  const parsedToolContent = React.useMemo(
    () => toolResult ? parseContent(toolResult.output) : null,
    [toolResult, parseContent],
  );

  const formatAsString = (content: any) => {
    if (typeof content === 'object' && content !== null) {
      return JSON.stringify(content, null, 2);
    }
    return String(content);
  };

  const formattedAssistantContent = React.useMemo(
    () => parsedAssistantContent ? formatAsString(parsedAssistantContent) : null,
    [parsedAssistantContent]
  );

  const formattedToolContent = React.useMemo(
    () => parsedToolContent ? formatAsString(parsedToolContent) : null,
    [parsedToolContent]
  );

  // Add copy functionality state
  const [isCopyingInput, setIsCopyingInput] = React.useState(false);
  const [isCopyingOutput, setIsCopyingOutput] = React.useState(false);

  // Copy functions
  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  }, []);

  const handleCopyInput = React.useCallback(async () => {
    if (!formattedAssistantContent) return;

    setIsCopyingInput(true);
    const success = await copyToClipboard(formattedAssistantContent);
    if (success) {
      toast.success('File content copied to clipboard');
    } else {
      toast.error('Failed to copy file content');
    }
    setTimeout(() => setIsCopyingInput(false), 500);
  }, [formattedAssistantContent, copyToClipboard]);

  const handleCopyOutput = React.useCallback(async () => {
    if (!formattedToolContent) return;

    setIsCopyingOutput(true);
    const success = await copyToClipboard(formattedToolContent);
    if (success) {
      toast.success('File content copied to clipboard');
    } else {
      toast.error('Failed to copy file content');
    }
    setTimeout(() => setIsCopyingOutput(false), 500);
  }, [formattedToolContent, copyToClipboard]);

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
  const toolTitle = (toolCall as any)._display_hint || getToolTitle(name);

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border bg-muted/10">
              <AppIcon toolCall={toolCall} size={20} className="w-5 h-5" />
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
                <CheckCircle className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {isSuccess ? 'Tool executed successfully' : 'Tool execution failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Executing
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Wrench}
            iconColor="text-orange-500 dark:text-orange-400"
            bgColor="bg-gradient-to-b from-orange-100 to-orange-50 shadow-inner dark:from-orange-800/40 dark:to-orange-900/60 dark:shadow-orange-950/20"
            title={toolTitle}
            filePath={name}
            showProgress={true}
          />
        ) : formattedAssistantContent || formattedToolContent ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              {formattedAssistantContent && (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 flex items-center justify-between">
                    <div className="flex items-center">
                      Input
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyInput}
                      disabled={isCopyingInput}
                      className="h-6 w-6 p-0"
                      title="Copy file content"
                    >
                      {isCopyingInput ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="border-muted bg-muted/20 rounded-lg overflow-hidden border">
                    <div className="p-4">
                      {typeof parsedAssistantContent === 'object' && parsedAssistantContent !== null ? (
                        <SmartJsonViewer data={parsedAssistantContent} />
                      ) : (
                        <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words font-mono">
                          {formattedAssistantContent}
                        </pre>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {formattedToolContent && (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 flex items-center justify-between">
                    <div className="flex items-center">
                      Output
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyOutput}
                      disabled={isCopyingOutput}
                      className="h-6 w-6 p-0"
                      title="Copy file content"
                    >
                      {isCopyingOutput ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="border-muted bg-muted/20 rounded-lg overflow-hidden border">
                    <div className="p-4">
                      {typeof parsedToolContent === 'object' && parsedToolContent !== null ? (
                        <SmartJsonViewer data={parsedToolContent} />
                      ) : (
                        <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words font-mono">
                          {formattedToolContent}
                        </pre>
                      )}
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
          {!isStreaming && (formattedAssistantContent || formattedToolContent) && (
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
