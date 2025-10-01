import React, { useState, useEffect } from 'react';
import {
  Globe,
  CheckCircle,
  AlertTriangle,
  Loader2,
  FileText,
  Copy,
  Check,
  ArrowUpRight,
  BookOpen
} from 'lucide-react';
import { ToolViewProps } from './types';
import {
  extractCrawlUrl,
  extractWebpageContent,
  formatTimestamp,
  getToolTitle,
  extractToolData,
} from './utils';
import { cn, truncateString } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function WebCrawlToolView({
  name = 'crawl-webpage',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { resolvedTheme } = useTheme();
  const [progress, setProgress] = useState(0);
  const [copiedContent, setCopiedContent] = useState(false);

  // Try to extract data using the new parser first
  const assistantToolData = extractToolData(assistantContent);
  const toolToolData = extractToolData(toolContent);

  let url: string | null = null;

  // Use data from the new format if available
  if (assistantToolData.toolResult) {
    url = assistantToolData.url;
  } else if (toolToolData.toolResult) {
    url = toolToolData.url;
  }

  // If not found in new format, fall back to legacy extraction
  if (!url) {
    url = extractCrawlUrl(assistantContent);
  }

  const webpageContent = extractWebpageContent(toolContent);
  const toolTitle = getToolTitle(name);

  // Format domain for display
  const formatDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch (e) {
      return url;
    }
  };

  const domain = url ? formatDomain(url) : 'Unknown';

  // Get favicon
  const getFavicon = (url: string) => {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch (e) {
      return null;
    }
  };

  const favicon = url ? getFavicon(url) : null;

  // Simulate progress when streaming
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

  const copyContent = async () => {
    if (!webpageContent?.text) return;

    try {
      await navigator.clipboard.writeText(webpageContent.text);
      setCopiedContent(true);
      setTimeout(() => setCopiedContent(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getContentStats = (content: string) => {
    if (!content || typeof content !== 'string') {
      return { wordCount: 0, charCount: 0, lineCount: 0 };
    }
    const wordCount = content.trim().split(/\s+/).length;
    const charCount = content.length;
    const lineCount = content.split('\n').length;

    return { wordCount, charCount, lineCount };
  };

  const contentStats = webpageContent?.text ? getContentStats(webpageContent.text) : null;

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
              {isSuccess ? 'Crawling completed' : 'Crawling failed'}
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
                Crawling Webpage
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
                Fetching content from <span className="font-mono text-xs break-all">{domain}</span>
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

              {/* Content Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    <BookOpen className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                    Extracted Content
                  </div>
                  {contentStats && (
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {contentStats.wordCount} words
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {contentStats.charCount} chars
                      </Badge>
                    </div>
                  )}
                </div>

                {webpageContent?.text ? (
                  <div className="group relative bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden hover:border-zinc-300 dark:hover:border-zinc-700 transition-all duration-200 hover:shadow-sm">
                    {/* Content Header */}
                    <div className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-600/10 flex items-center justify-center border border-blue-500/20">
                          <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            Page Content
                          </p>
                          {contentStats && (
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">
                              {contentStats.lineCount} lines
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className={cn(
                                  "opacity-70 group-hover:opacity-100 transition-all duration-200",
                                  copiedContent && "opacity-100"
                                )}
                                onClick={copyContent}
                              >
                                {copiedContent ? (
                                  <Check className="w-4 h-4 text-green-600" />
                                ) : (
                                  <Copy className="w-4 h-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{copiedContent ? 'Copied!' : 'Copy content'}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>

                    {/* Content Body */}
                    <div className="p-4 max-h-96 overflow-auto">
                      <pre className="text-xs font-mono text-zinc-800 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">
                        {webpageContent.text}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60 mx-auto">
                      <FileText className="h-8 w-8 text-zinc-400 dark:text-zinc-600" />
                    </div>
                    <h3 className="text-lg font-medium mb-2 text-zinc-900 dark:text-zinc-100">
                      No Content Extracted
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto">
                      The webpage might be restricted, empty, or require JavaScript to load content
                    </p>
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
              Unable to extract a valid URL from the crawling request
            </p>
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && webpageContent?.text && (
            <Badge className="h-6 py-0.5">
              <div className="w-2 h-2 rounded-full bg-green-500 mr-1.5" />
              Content extracted
            </Badge>
          )}
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