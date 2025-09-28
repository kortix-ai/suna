import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Presentation, 
  Clock, 
  BookOpen, 
  CheckCircle, 
  AlertTriangle,
  Loader2
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, extractToolData } from '../utils';
import { cn } from '@/lib/utils';
import { LoadingState } from '../shared/LoadingState';

export function PresentationOutlineToolView({
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  name,
  project,
}: ToolViewProps) {
  const { toolResult } = extractToolData(toolContent);
  
  let outlineData: any = null;
  let error: string | null = null;

  try {
    if (toolResult && toolResult.toolOutput && toolResult.toolOutput !== 'STREAMING') {
      const output = toolResult.toolOutput;
      if (typeof output === 'string') {
        try {
          outlineData = JSON.parse(output);
        } catch (e) {
          console.error('Failed to parse tool output:', e);
          error = 'Failed to parse presentation outline data';
        }
      } else {
        outlineData = output;
      }
    }
  } catch (e) {
    console.error('Error parsing presentation outline:', e);
    error = 'Failed to parse presentation outline data';
  }

  const { title, subtitle, slide_count, slides } = outlineData || {};

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <Presentation className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Presentation Outline
              </CardTitle>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isStreaming && !error && outlineData && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Success
              </Badge>
            )}
            {!isStreaming && (error || !isSuccess) && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              >
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                Failed
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Presentation}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Creating presentation outline"
            filePath="Processing outline..."
            showProgress={true}
          />
        ) : error || !outlineData ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {error || 'Failed to create presentation outline'}
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              There was an error creating the presentation outline. Please try again.
            </p>
          </div>
        ) : (
          <div className="h-full">
            <ScrollArea className="h-full">
              <div className="p-6 space-y-3">
                {slides?.map((slide: any, index: number) => (
                  <div
                    key={index}
                    className={cn(
                      "group relative rounded-xl border bg-card hover:bg-muted/30 transition-all duration-200",
                      "hover:shadow-sm hover:border-primary/30"
                    )}
                  >
                    <div className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 mt-1">
                          <div className={cn(
                            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold",
                            index === 0 
                              ? "bg-primary text-primary-foreground" 
                              : "bg-muted text-muted-foreground"
                          )}>
                            {index + 1}
                          </div>
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between mb-0.5">
                            <h3 className="text-base font-medium text-foreground group-hover:text-primary transition-colors line-clamp-2">
                              {slide.title}
                            </h3>
                            {index === 0 && (
                              <Badge className="text-xs ml-2 flex-shrink-0">
                                Title
                              </Badge>
                            )}
                          </div>
                          
                          <p className="text-sm text-muted-foreground leading-relaxed mb-3 line-clamp-3">
                            {slide.description}
                          </p>
                          
                          {slide.notes && (
                            <div className="bg-muted/50 rounded-xl p-3 border border-muted">
                              <div className="flex items-center gap-2 mb-2">
                                <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-xs font-medium text-muted-foreground">Speaker Notes</span>
                              </div>
                              <p className="text-xs text-muted-foreground line-clamp-2">{slide.notes}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-end items-center">
        <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
          <Clock className="h-3 w-3" />
          <span>
            {toolTimestamp && !isStreaming
              ? formatTimestamp(toolTimestamp)
              : assistantTimestamp
                ? formatTimestamp(assistantTimestamp)
                : ''}
          </span>
        </div>
      </div>
    </Card>
  );
} 