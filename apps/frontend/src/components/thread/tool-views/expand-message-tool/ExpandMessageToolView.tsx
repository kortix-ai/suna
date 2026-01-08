import React from 'react';
import {
  Expand,
  CheckCircle,
  AlertTriangle,
  Clock,
  MessageSquareText,
  Copy,
  Check,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { extractExpandMessageData } from './_utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { UnifiedMarkdown } from '@/components/markdown';

export function ExpandMessageToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // All hooks must be called unconditionally at the top
  const [isCopying, setIsCopying] = React.useState(false);

  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  }, []);

  // Extract data (handle undefined case)
  const extractedData = toolCall ? extractExpandMessageData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  ) : null;

  const message = extractedData?.message;
  const handleCopyMessage = React.useCallback(async () => {
    if (!message) return;

    setIsCopying(true);
    const success = await copyToClipboard(message);
    if (success) {
      toast.success('Message copied to clipboard');
    } else {
      toast.error('Failed to copy message');
    }
    setTimeout(() => setIsCopying(false), 500);
  }, [message, copyToClipboard]);

  // Defensive check - handle cases where toolCall might be undefined
  if (!toolCall) {
    console.warn('ExpandMessageToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name) || 'Message Expansion';
  
  const {
    messageId,
    status,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractedData || {
    messageId: null,
    message: null,
    status: null,
    actualIsSuccess: false,
    actualToolTimestamp: null,
    actualAssistantTimestamp: null
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
              <Expand className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-4">
            {/* Message ID */}
            {messageId && (
              <div className="flex items-center gap-2">
                <Badge 
                  variant="outline" 
                  className="font-mono text-xs bg-zinc-50 dark:bg-zinc-900/20 border-zinc-200 dark:border-zinc-700"
                >
                  ID: {messageId}
                </Badge>
              </div>
            )}

            {/* Expanded Message Content - Simple display */}
            {message ? (
              <div className="bg-muted/30 rounded-lg p-4 border border-border overflow-hidden">
                <UnifiedMarkdown content={message} isStreaming={isStreaming} />
              </div>
            ) : !isStreaming ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-4 border-2 border-zinc-200 dark:border-zinc-700">
                  <MessageSquareText className="h-8 w-8 text-zinc-500 dark:text-zinc-400" />
                </div>
                <h3 className="text-lg font-medium text-foreground mb-2">
                  {actualIsSuccess ? 'No Message Content' : 'Expansion Failed'}
                </h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  {actualIsSuccess 
                    ? 'The expanded message does not contain any displayable content.'
                    : 'Unable to expand the requested message. It may not exist or you may not have access to it.'}
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </CardContent>

      <div className="px-4 py-2 h-10 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-700 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <Badge className="h-6 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700" variant="outline">
            <Expand className="h-3 w-3 mr-1" />
            Message Retrieval
          </Badge>
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          {actualToolTimestamp 
            ? formatTimestamp(actualToolTimestamp) 
            : actualAssistantTimestamp 
            ? formatTimestamp(actualAssistantTimestamp) 
            : ''}
        </div>
      </div>
    </Card>
  );
}

