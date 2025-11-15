import React, { useState, useEffect } from 'react';
import {
  MessageCircleQuestion,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Clock,
  MessageSquare,
  Paperclip,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import {
  formatTimestamp,
  getToolTitle,
} from '../utils';
import { extractAskData } from './_utils';
import { cn, truncateString } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileAttachment } from '../../file-attachment';

interface AskToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

export function AskToolView({
  name = 'ask',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
  project,
}: AskToolViewProps) {

  const {
    text,
    attachments,
    status,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractAskData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );



  const isImageFile = (filePath: string): boolean => {
    const filename = filePath.split('/').pop() || '';
    return filename.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) !== null;
  };

  const isPreviewableFile = (filePath: string): boolean => {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return ext === 'html' || ext === 'htm' || ext === 'md' || ext === 'markdown' || ext === 'csv' || ext === 'tsv' || ext === 'pdf' || ext === 'xlsx' || ext === 'xls';
  };

  const toolTitle = getToolTitle(name) || 'Ask User';

  const handleFileClick = (filePath: string) => {
    if (onFileClick) {
      onFileClick(filePath);
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <MessageCircleQuestion className="w-5 h-5 text-blue-500 dark:text-blue-400" />
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
              {actualIsSuccess ? 'Success' : 'Failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Asking user
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Loader2 className="h-8 w-8 text-blue-500 animate-spin mb-4" />
            <p className="text-sm text-muted-foreground">Asking user...</p>
          </div>
        ) : (text || attachments?.length || status || toolContent || assistantContent) ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-6">
              {/* Display the question text */}
              {text && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <MessageSquare className="h-4 w-4" />
                    Question
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                      {text}
                    </p>
                  </div>
                </div>
              )}

              {/* Display status if available */}
              {status && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    Status
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <p className="text-sm text-foreground">{status}</p>
                  </div>
                </div>
              )}

              {/* Display attachments */}
              {attachments && attachments.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Paperclip className="h-4 w-4" />
                    Files ({attachments.length})
                  </div>

                  <div className={cn(
                    "grid gap-3",
                    attachments.length === 1 ? "grid-cols-1" :
                      attachments.length > 4 ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-3" :
                        "grid-cols-1 sm:grid-cols-2"
                  )}>
                    {attachments
                      .sort((a, b) => {
                        const aIsImage = isImageFile(a);
                        const bIsImage = isImageFile(b);
                        const aIsPreviewable = isPreviewableFile(a);
                        const bIsPreviewable = isPreviewableFile(b);

                        if (aIsImage && !bIsImage) return -1;
                        if (!aIsImage && bIsImage) return 1;
                        if (aIsPreviewable && !bIsPreviewable) return -1;
                        if (!aIsPreviewable && bIsPreviewable) return 1;
                        return 0;
                      })
                      .map((attachment, index) => {
                        const isImage = isImageFile(attachment);
                        const isPreviewable = isPreviewableFile(attachment);
                        const shouldSpanFull = (attachments!.length % 2 === 1 &&
                          attachments!.length > 1 &&
                          index === attachments!.length - 1);

                        return (
                          <div
                            key={index}
                            className={cn(
                              "relative group",
                              isImage ? "flex items-center justify-center h-full" : "",
                              isPreviewable ? "w-full" : ""
                            )}
                            style={(shouldSpanFull || isPreviewable) ? { gridColumn: '1 / -1' } : undefined}
                          >
                            <FileAttachment
                              filepath={attachment}
                              onClick={handleFileClick}
                              sandboxId={project?.sandbox?.id}
                              showPreview={true}
                              className={cn(
                                isImage ? "aspect-square w-full" : "w-full",
                                isImage ? "" :
                                  isPreviewable ? "min-h-full max-h-[400px] overflow-auto" : "h-[54px]"
                              )}
                              customStyle={
                                isImage ? {
                                  width: '100%',
                                  height: '100%',
                                  '--attachment-height': '100%'
                                } as React.CSSProperties :
                                  isPreviewable ? {
                                    gridColumn: '1 / -1'
                                  } :
                                    shouldSpanFull ? {
                                      gridColumn: '1 / -1'
                                    } : {
                                      width: '100%'
                                    }
                              }
                              collapsed={false}
                              project={project}
                            />
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Fallback: Show raw toolContent if extraction didn't produce text/attachments but content exists */}
              {!text && !attachments?.length && !status && (toolContent || assistantContent) && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <MessageSquare className="h-4 w-4" />
                    Content
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                      {typeof toolContent === 'string' 
                        ? toolContent 
                        : typeof assistantContent === 'string'
                          ? assistantContent
                          : JSON.stringify(toolContent || assistantContent, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <MessageSquare className="h-8 w-8 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              No Content Available
            </h3>
            <p className="text-sm text-muted-foreground">
              This ask tool execution did not produce any content to display.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge className="h-6 py-0.5" variant="outline">
            <MessageCircleQuestion className="h-3 w-3" />
            User Interaction
          </Badge>
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualAssistantTimestamp ? formatTimestamp(actualAssistantTimestamp) : ''}
        </div>
      </div>
    </Card>
  );
} 