import React, { useState, useEffect } from 'react';
import {
  Globe,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Loader2,
  FileText,
  Clock,
  Copy,
  Download,
  Folder,
  ChevronRight,
  Server,
  Calendar,
  Check,
  ArrowUpRight,
  Zap
} from 'lucide-react';
import { ToolViewProps } from '../types';
import {
  formatTimestamp,
  getToolTitle,
} from '../utils';
import { extractWebScrapeData } from './_utils';
import { cn, truncateString } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function WebScrapeToolView({
  name = 'scrape-webpage',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';
  const [progress, setProgress] = useState(0);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  const {
    url,
    urls,
    success,
    message,
    files,
    urlCount,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractWebScrapeData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);
  const formatDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch (e) {
      return url;
    }
  };

  const domain = url ? formatDomain(url) : 'Unknown';

  const getFavicon = (url: string) => {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch (e) {
      return null;
    }
  };

  const favicon = url ? getFavicon(url) : null;

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

  const copyFilePath = async (filePath: string) => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopiedFile(filePath);
      setTimeout(() => setCopiedFile(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const formatFileInfo = (filePath: string) => {
    const timestampMatch = filePath.match(/(\d{8}_\d{6})/);
    const domainMatch = filePath.match(/(\w+)_com\.json$/);
    const fileName = filePath.split('/').pop() || filePath;

    return {
      timestamp: timestampMatch ? timestampMatch[1] : '',
      domain: domainMatch ? domainMatch[1] : 'unknown',
      fileName,
      fullPath: filePath
    };
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 border border-primary/20">
              <Globe className="w-5 h-5 text-primary" />
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
                <CheckCircle className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {actualIsSuccess ? 'Scraping completed' : 'Scraping failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="text-center w-full max-w-xs">
              <div className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/10 border border-primary/20">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
              <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                Extracting Content
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
                Analyzing and processing <span className="font-mono text-xs break-all">{domain}</span>
              </p>
              <Progress value={progress} className="w-full h-1" />
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">{progress}% complete</p>
            </div>
          </div>
        ) : url ? (
          // Results State
          <ScrollArea className="h-full w-full">
            <div className="p-4 py-0 my-4">
              {/* Target URL Section */}
              <div className="space-y-3 mb-6">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  <Globe className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                  Source URL
                </div>
                <div className="group relative">
                  <div className="flex items-center gap-3 p-4 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors rounded-xl border border-zinc-200 dark:border-zinc-800">
                    {favicon && (
                      <img
                        src={favicon}
                        alt=""
                        className="w-6 h-6 rounded-md flex-shrink-0"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-sm text-zinc-900 dark:text-zinc-100 truncate">{truncateString(url, 70)}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{domain}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="opacity-70 group-hover:opacity-100 transition-opacity"
                      asChild
                    >
                      <a href={url} target="_blank" rel="noopener noreferrer">
                        <ArrowUpRight className="w-4 h-4" />
                      </a>
                    </Button>
                  </div>
                </div>
              </div>

              {/* Results Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    <Zap className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                    Generated Files
                  </div>
                  <Badge variant="outline" className="gap-1">
                    {files.length} file{files.length !== 1 ? 's' : ''}
                  </Badge>
                </div>

                {/* File List */}
                {files.length > 0 ? (
                  <div className="space-y-3">
                    {files.map((filePath, idx) => {
                      const fileInfo = formatFileInfo(filePath);
                      const isCopied = copiedFile === filePath;

                      return (
                        <div
                          key={idx}
                          className="group relative bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all duration-200 hover:shadow-sm"
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-green-500/20 to-green-600/10 flex items-center justify-center border border-green-500/20 flex-shrink-0">
                              <FileText className="w-5 h-5 text-green-600 dark:text-green-400" />
                            </div>

                            <div className="flex-1 min-w-0 space-y-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant="outline" className="text-xs font-normal">
                                  JSON
                                </Badge>
                                {fileInfo.timestamp && (
                                  <Badge variant="outline" className="text-xs font-normal">
                                    <Calendar className="w-3 h-3 mr-1" />
                                    {fileInfo.timestamp.replace('_', ' ')}
                                  </Badge>
                                )}
                              </div>

                              <div className="space-y-1">
                                <p className="font-mono text-sm text-zinc-900 dark:text-zinc-100 font-medium">
                                  {fileInfo.fileName}
                                </p>
                                <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400 truncate">
                                  {fileInfo.fullPath}
                                </p>
                              </div>
                            </div>

                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      "opacity-0 group-hover:opacity-100 transition-all duration-200",
                                      isCopied && "opacity-100"
                                    )}
                                    onClick={() => copyFilePath(filePath)}
                                  >
                                    {isCopied ? (
                                      <Check className="w-4 h-4 text-green-600" />
                                    ) : (
                                      <Copy className="w-4 h-4" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>{isCopied ? 'Copied!' : 'Copy file path'}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-8 text-zinc-500 dark:text-zinc-400">
                    <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No files generated</p>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <Globe className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No URL Detected
            </h3>
            <p className="text-zinc-500 dark:text-zinc-400 text-center max-w-sm">
              Unable to extract a valid URL from the scraping request
            </p>
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && files.length > 0 && (
            <Badge className="h-6 py-0.5">
              <div className="w-2 h-2 rounded-full bg-green-500 mr-1.5" />
              {files.length} file{files.length !== 1 ? 's' : ''} saved
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualToolTimestamp && !isStreaming
            ? formatTimestamp(actualToolTimestamp)
            : actualAssistantTimestamp
              ? formatTimestamp(actualAssistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}