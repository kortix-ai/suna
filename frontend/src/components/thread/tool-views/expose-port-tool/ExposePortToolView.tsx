import React, { useMemo, useState, useEffect } from 'react';
import {
  ExternalLink,
  CheckCircle,
  AlertTriangle,
  Globe,
  Loader2,
  Link2,
  Computer,
  Check
} from 'lucide-react';
import { ToolViewProps } from '../types';
import {
  formatTimestamp,
  getToolTitle,
  normalizeContentToString,
  extractToolData,
} from '../utils';
import { extractExposePortData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from '@/components/ui/button';
import { LoadingState } from '../shared/LoadingState';

export function ExposePortToolView({
  name = 'expose-port',
  assistantContent,
  toolContent,
  isSuccess = true,
  isStreaming = false,
  assistantTimestamp,
  toolTimestamp,
}: ToolViewProps) {

  const {
    port,
    url,
    message,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractExposePortData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20">
              <Computer className="w-5 h-5 text-green-500 dark:text-green-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Port Exposure
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
              {actualIsSuccess ? 'Port exposed successfully' : 'Failed to expose port'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Computer}
            iconColor="text-emerald-500 dark:text-emerald-400"
            bgColor="bg-gradient-to-b from-emerald-100 to-emerald-50 shadow-inner dark:from-emerald-800/40 dark:to-emerald-900/60 dark:shadow-emerald-950/20"
            title="Exposing port"
            filePath={port?.toString()}
            showProgress={true}
          />
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="p-4 py-0 my-4 space-y-6">
              {url && (
                <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-sm overflow-hidden">
                  <div className="p-4">
                    <div className="flex items-start gap-3 mb-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200 mb-2">
                          Exposed URL
                        </h3>
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-md font-medium text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-2 mb-3"
                        >
                          {url}
                          <ExternalLink className="flex-shrink-0 h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex flex-col gap-1.5">
                        <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                          Port Details
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <Badge variant="outline" className="bg-zinc-50 dark:bg-zinc-800 font-mono">
                            Port: {port}
                          </Badge>
                        </div>
                      </div>

                      {message && (
                        <div className="text-sm text-zinc-600 dark:text-zinc-400">
                          {message}
                        </div>
                      )}

                      <div className="text-xs bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/50 rounded-md p-3 text-amber-600 dark:text-amber-400 flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <span>This URL might only be temporarily available and could expire after some time.</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Empty State */}
              {!port && !url && !isStreaming && (
                <div className="flex flex-col items-center justify-center py-12 px-6">
                  <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
                    <Computer className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
                    No Port Information
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
                    No port exposure information is available yet. Use the expose-port command to share a local port.
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && port && (
            <Badge variant="outline">
              <Computer className="h-3 w-3 mr-1" />
              Port {port}
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualToolTimestamp && formatTimestamp(actualToolTimestamp)}
        </div>
      </div>
    </Card>
  );
}
