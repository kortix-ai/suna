import React from 'react';
import {
  ExternalLink,
  CheckCircle,
  AlertTriangle,
  Computer,
  Clock
} from 'lucide-react';
import { ToolViewProps } from '../types';
import {
  formatTimestamp,
  getToolTitle
} from '../utils';
import { extractExposePortData } from './_utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
    actualToolTimestamp
  } = extractExposePortData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

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
                {toolTitle}
              </CardTitle>
            </div>
          </div>
          
          <div className='flex items-center gap-2'>
            {url && !isStreaming && (
              <Button variant="outline" size="sm" className="h-8 text-xs bg-white dark:bg-muted/50 hover:bg-zinc-100 dark:hover:bg-zinc-800 shadow-none" asChild>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  Open in Browser
                </a>
              </Button>
            )}
            
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
                {actualIsSuccess ? 'Port exposed successfully' : 'Port exposure failed'}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Computer}
            iconColor="text-green-500 dark:text-green-400"
            bgColor="bg-gradient-to-b from-green-100 to-green-50 shadow-inner dark:from-green-800/40 dark:to-green-900/60 dark:shadow-green-950/20"
            title="Exposing port"
            filePath={port?.toString()}
            showProgress={true}
          />
        ) : url ? (
          <div className="flex flex-col h-full">
            {/* Port Information Header */}
            <div className="p-4 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
              <div className="flex flex-col space-y-3">
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200 mb-2">
                    Exposed URL
                  </h3>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-2 break-all"
                  >
                    {url}
                    <ExternalLink className="flex-shrink-0 h-3.5 w-3.5" />
                  </a>
                </div>
                {/* {port && (
                  <div className="flex items-center">
                    <Badge variant="outline" className="bg-zinc-50 dark:bg-zinc-800 font-mono">
                      Port: {port}
                    </Badge>
                  </div>
                )} */}
              </div>
              
              {message && (
                <div className="text-sm text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded-md p-3 mt-3">
                  {message}
                </div>
              )}
              
              <div className="text-xs bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-md p-3 text-amber-700 dark:text-amber-300 flex items-start gap-2 mt-3">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>This URL is temporarily available and may expire after some time.</span>
              </div>
            </div>
            {/* Iframe Preview */}
            <div className="flex-1 bg-white dark:bg-zinc-950">
              <iframe
                src={url}
                title={`Port ${port} Preview`}
                className="w-full h-full border-0"
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-green-100 to-green-50 shadow-inner dark:from-green-800/40 dark:to-green-900/60">
              <Computer className="h-10 w-10 text-green-500 dark:text-green-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Port Information
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              No port exposure information is available yet. Use the expose-port command to share a local port.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && port && (
            <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
              <Computer className="h-3 w-3 mr-1" />
              Port {port}
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5" />
          {actualToolTimestamp && formatTimestamp(actualToolTimestamp)}
        </div>
      </div>
    </Card>
  );
}
