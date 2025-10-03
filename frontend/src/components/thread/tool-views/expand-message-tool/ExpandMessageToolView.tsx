import React from 'react';
import {
  Expand,
  CheckCircle,
  AlertTriangle,
  Loader2,
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
import { toast } from 'sonner';
import Markdown from 'react-markdown';

export function ExpandMessageToolView({
  name = 'expand_message',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const {
    messageId,
    message,
    status,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractExpandMessageData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const [isCopying, setIsCopying] = React.useState(false);
  const toolTitle = getToolTitle(name) || 'Message Expansion';

  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  }, []);

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

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
              <Expand className="w-5 h-5 text-purple-500 dark:text-purple-400" />
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
                actualIsSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {actualIsSuccess ? 'Expanded' : 'Failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-purple-200 to-purple-100 text-purple-700 dark:from-purple-800/50 dark:to-purple-900/60 dark:text-purple-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Expanding
            </Badge>
          )}
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
                  className="font-mono text-xs bg-purple-50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-800"
                >
                  ID: {messageId}
                </Badge>
              </div>
            )}

            {/* Expanded Message Content - Simple display */}
            {message ? (
              <div className="bg-muted/30 rounded-lg p-4 border border-border overflow-hidden">
                <div className="prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 break-words overflow-wrap-anywhere [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:break-words">
                  <Markdown>{message}</Markdown>
                </div>
              </div>
            ) : !isStreaming ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-16 h-16 rounded-full bg-purple-100 dark:bg-purple-900/20 flex items-center justify-center mb-4 border-2 border-purple-200 dark:border-purple-800">
                  <MessageSquareText className="h-8 w-8 text-purple-500 dark:text-purple-400" />
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

      <div className="px-4 py-2 h-10 backdrop-blur-sm border-t border-purple-200 dark:border-purple-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-purple-600 dark:text-purple-400">
          <Badge className="h-6 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800" variant="outline">
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

