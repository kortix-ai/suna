import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ListChecks,
  Sparkles,
  Trophy,
  Paperclip,
  ExternalLink,
} from 'lucide-react';
import { ToolViewProps } from './types';
import {
  formatTimestamp,
  getToolTitle,
  normalizeContentToString,
  extractToolData,
  getFileIconAndColor,
} from './utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from '@/components/ui/progress';
import { Markdown } from '@/components/ui/markdown';

interface CompleteContent {
  summary?: string;
  result?: string;
  tasksCompleted?: string[];
  finalOutput?: string;
  attachments?: string[];
}

interface CompleteToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

export function CompleteToolView({
  name = 'complete',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
}: CompleteToolViewProps) {
  const [completeData, setCompleteData] = useState<CompleteContent>({});
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (assistantContent) {
      try {
        const contentStr = normalizeContentToString(assistantContent);

        let cleanContent = contentStr
          .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
          .replace(/<invoke name="complete"[\s\S]*?<\/invoke>/g, '')
          .trim();

        const completeMatch = cleanContent.match(/<complete[^>]*>([^<]*)<\/complete>/);
        if (completeMatch) {
          setCompleteData(prev => ({ ...prev, summary: completeMatch[1].trim() }));
        } else if (cleanContent) {
          setCompleteData(prev => ({ ...prev, summary: cleanContent }));
        }

        const attachmentsMatch = contentStr.match(/attachments=["']([^"']*)["']/i);
        if (attachmentsMatch) {
          const attachments = attachmentsMatch[1].split(',').map(a => a.trim()).filter(a => a.length > 0);
          setCompleteData(prev => ({ ...prev, attachments }));
        }

        const taskMatches = cleanContent.match(/- ([^\n]+)/g);
        if (taskMatches) {
          const tasks = taskMatches.map(task => task.replace('- ', '').trim());
          setCompleteData(prev => ({ ...prev, tasksCompleted: tasks }));
        }
      } catch (e) {
        console.error('Error parsing complete content:', e);
      }
    }
  }, [assistantContent]);

  useEffect(() => {
    if (toolContent && !isStreaming) {
      try {
        const contentStr = normalizeContentToString(toolContent);
        const toolResultMatch = contentStr.match(/ToolResult\([^)]*output=['"]([^'"]+)['"]/);
        if (toolResultMatch) {
          setCompleteData(prev => ({ ...prev, result: toolResultMatch[1] }));
        } else {
          setCompleteData(prev => ({ ...prev, result: contentStr }));
        }
      } catch (e) {
        console.error('Error parsing tool response:', e);
      }
    }
  }, [toolContent, isStreaming]);

  useEffect(() => {
    if (isStreaming) {
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            clearInterval(timer);
            return prevProgress;
          }
          return prevProgress + 5;
        });
      }, 300);
      return () => clearInterval(timer);
    } else {
      setProgress(100);
    }
  }, [isStreaming]);

  const toolTitle = getToolTitle(name) || 'Task Complete';

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
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
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
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {isSuccess ? 'Completed' : 'Failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Completing
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-6">
            {/* Success Animation/Icon - Only show when completed successfully */}
            {!isStreaming && isSuccess && !completeData.summary && !completeData.tasksCompleted && !completeData.attachments && (
              <div className="flex justify-center">
                <div className="relative">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-emerald-100 to-emerald-200 dark:from-emerald-800/40 dark:to-emerald-900/60 flex items-center justify-center">
                    <Trophy className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="absolute -top-1 -right-1">
                    <Sparkles className="h-5 w-5 text-yellow-500 animate-pulse" />
                  </div>
                </div>
              </div>
            )}

            {/* Summary Section */}
            {completeData.summary && (
              <div className="space-y-2">
                <div className="bg-muted/50 rounded-2xl p-4 border border-border">
                  <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">
                    {completeData.summary}
                  </Markdown>
                </div>
              </div>
            )}

            {/* Attachments Section */}
            {completeData.attachments && completeData.attachments.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Paperclip className="h-4 w-4" />
                  Files ({completeData.attachments.length})
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {completeData.attachments.map((attachment, index) => {
                    const { icon: FileIcon, color, bgColor } = getFileIconAndColor(attachment);
                    const fileName = attachment.split('/').pop() || attachment;
                    const filePath = attachment.includes('/') ? attachment.substring(0, attachment.lastIndexOf('/')) : '';

                    return (
                      <button
                        key={index}
                        onClick={() => handleFileClick(attachment)}
                        className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg border border-border/50 hover:bg-muted/50 transition-colors group cursor-pointer text-left"
                      >
                        <div className="flex-shrink-0">
                          <div className={cn(
                            "w-10 h-10 rounded-lg bg-gradient-to-br flex items-center justify-center",
                            bgColor
                          )}>
                            <FileIcon className={cn("h-5 w-5", color)} />
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {fileName}
                          </p>
                          {filePath && (
                            <p className="text-xs text-muted-foreground truncate">
                              {filePath}
                            </p>
                          )}
                        </div>
                        <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <ExternalLink className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tasks Completed Section */}
            {completeData.tasksCompleted && completeData.tasksCompleted.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <ListChecks className="h-4 w-4" />
                  Tasks Completed
                </div>
                <div className="space-y-2">
                  {completeData.tasksCompleted.map((task, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg border border-border/50"
                    >
                      <div className="mt-1 flex-shrink-0">
                        <CheckCircle className="h-4 w-4 text-emerald-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0">
                          {task}
                        </Markdown>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Progress Section for Streaming */}
            {isStreaming && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Completing task...
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {progress}%
                  </span>
                </div>
                <Progress value={progress} className="h-1" />
              </div>
            )}

            {/* Empty State */}
            {!completeData.summary && !completeData.result && !completeData.attachments && !completeData.tasksCompleted && !isStreaming && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                  <CheckCircle2 className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium text-foreground mb-2">
                  Task Completed
                </h3>
                <p className="text-sm text-muted-foreground">
                  No additional details provided
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge className="h-6 py-0.5" variant="outline">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Task Completion
          </Badge>
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
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