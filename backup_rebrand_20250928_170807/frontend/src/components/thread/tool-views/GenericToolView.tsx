'use client'

import React from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Clock,
  Wrench,
  Copy,
  Check,
} from 'lucide-react';
import { ToolViewProps } from './types';
import { formatTimestamp, getToolTitle, extractToolData } from './utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from '@/components/ui/button';
import { LoadingState } from './shared/LoadingState';
import { toast } from 'sonner';

export function GenericToolView({
  name = 'generic-tool',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const toolTitle = getToolTitle(name);

  const formatContent = (content: any) => {
    if (!content) return null;

    // Use the new parser for backwards compatibility
    const { toolResult } = extractToolData(content);

    if (toolResult) {
      // Format the structured content nicely
      const formatted: any = {
        tool: toolResult.xmlTagName || toolResult.functionName,
      };

      if (toolResult.arguments && Object.keys(toolResult.arguments).length > 0) {
        formatted.parameters = toolResult.arguments;
      }

      if (toolResult.toolOutput) {
        formatted.output = toolResult.toolOutput;
      }

      if (toolResult.isSuccess !== undefined) {
        formatted.success = toolResult.isSuccess;
      }

      return JSON.stringify(formatted, null, 2);
    }

    // Fallback to legacy format handling
    if (typeof content === 'object') {
      // Check for direct structured format (legacy)
      if ('tool_name' in content || 'xml_tag_name' in content) {
        const formatted: any = {
          tool: content.tool_name || content.xml_tag_name || 'unknown',
        };

        if (content.parameters && Object.keys(content.parameters).length > 0) {
          formatted.parameters = content.parameters;
        }

        if (content.result) {
          formatted.result = content.result;
        }

        return JSON.stringify(formatted, null, 2);
      }

      // Check if it has a content field that might contain the structured data (legacy)
      if ('content' in content && typeof content.content === 'object') {
        const innerContent = content.content;
        if ('tool_name' in innerContent || 'xml_tag_name' in innerContent) {
          const formatted: any = {
            tool: innerContent.tool_name || innerContent.xml_tag_name || 'unknown',
          };

          if (innerContent.parameters && Object.keys(innerContent.parameters).length > 0) {
            formatted.parameters = innerContent.parameters;
          }

          if (innerContent.result) {
            formatted.result = innerContent.result;
          }

          return JSON.stringify(formatted, null, 2);
        }
      }

      // Fall back to old format handling
      if (content.content && typeof content.content === 'string') {
        return content.content;
      }
      return JSON.stringify(content, null, 2);
    }

    if (typeof content === 'string') {
      try {
        const parsedJson = JSON.parse(content);
        return JSON.stringify(parsedJson, null, 2);
      } catch (e) {
        return content;
      }
    }

    return String(content);
  };

  const formattedAssistantContent = React.useMemo(
    () => formatContent(assistantContent),
    [assistantContent],
  );
  const formattedToolContent = React.useMemo(
    () => formatContent(toolContent),
    [toolContent],
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

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
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
                      <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words font-mono">
                        {formattedAssistantContent}
                      </pre>
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
                      <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words font-mono">
                        {formattedToolContent}
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
