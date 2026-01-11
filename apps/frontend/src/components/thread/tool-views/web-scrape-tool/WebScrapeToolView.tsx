import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Globe,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  FileJson,
  Copy,
  Check,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ToolViewProps } from '../types';
import { getToolTitle } from '../utils';
import { extractWebScrapeData } from './_utils';
import { cn, truncateString } from '@/lib/utils';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { useSmoothToolField } from '@/hooks/messages';
import { toast } from '@/lib/toast';

export function WebScrapeToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  // Prepare raw arguments for hooks
  const rawArguments = toolCall?.rawArguments || toolCall?.arguments;

  // Apply smooth text streaming for URL field
  const smoothFields = useSmoothToolField(
    typeof rawArguments === 'object' && rawArguments ? rawArguments : {},
    { interval: 50 }
  );
  const smoothUrl = (smoothFields as any).url || (typeof rawArguments === 'object' ? rawArguments?.url : '') || '';
  const isUrlAnimating = isStreaming && !toolResult && !!toolCall;

  if (!toolCall) {
    console.warn('WebScrapeToolView: toolCall is undefined.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();

  const {
    url,
    urls,
    files,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractWebScrapeData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  // Use smooth URL when streaming
  const displayUrl = isStreaming && smoothUrl ? smoothUrl : url;
  const displayUrls = urls || (displayUrl ? [displayUrl] : []);

  const toolTitle = getToolTitle(name);

  const formatDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return url;
    }
  };

  const getFavicon = (url: string) => {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch {
      return null;
    }
  };

  const copyFilePath = async (filePath: string) => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopiedFile(filePath);
      setTimeout(() => setCopiedFile(null), 2000);
      toast.success('Path copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const getFileName = (filePath: string) => {
    const rawFileName = filePath.split('/').pop() || filePath;
    return rawFileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '');
  };

  // Loading state component matching WebSearchLoadingState style
  const LoadingState = () => {
    const urlsToShow = displayUrls.length > 0 ? displayUrls : ['Scraping...'];
    const reversedUrls = [...urlsToShow].reverse();

    return (
      <div className="flex flex-col items-center justify-center h-full py-8 px-6 overflow-auto">
        <div className="w-full max-w-md flex flex-col items-center">
          {/* Animated Globe Icon */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="relative mb-6"
          >
            <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center border border-zinc-200 dark:border-zinc-700">
              <motion.div
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              >
                <Globe className="w-7 h-7 text-zinc-600 dark:text-zinc-400" />
              </motion.div>
            </div>
            {/* Pulse ring */}
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-zinc-300 dark:border-zinc-600"
              animate={{ scale: [1, 1.3, 1.3], opacity: [0.6, 0, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
            />
          </motion.div>

          {/* Title */}
          <motion.h3
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-6"
          >
            Scraping webpage{displayUrls.length > 1 ? 's' : ''}
          </motion.h3>

          {/* URL List */}
          <div className="w-full">
            <div className="flex flex-col-reverse gap-2">
              {reversedUrls.map((urlItem, index) => {
                const originalIndex = urlsToShow.length - 1 - index;
                const delay = originalIndex * 0.08;
                const domain = urlItem !== 'Scraping...' ? formatDomain(urlItem) : urlItem;
                const favicon = urlItem !== 'Scraping...' ? getFavicon(urlItem) : null;

                return (
                  <motion.div
                    key={`${urlItem}-${index}`}
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{
                      duration: 0.4,
                      delay,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    className={cn(
                      'group flex items-center gap-3 px-4 py-3 rounded-xl',
                      'bg-white/80 dark:bg-zinc-800/60',
                      'border border-zinc-200/80 dark:border-zinc-700/50',
                      'shadow-sm',
                      'backdrop-blur-sm'
                    )}
                  >
                    {/* Favicon */}
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                        {favicon ? (
                          <img
                            src={favicon}
                            alt=""
                            className="w-4 h-4"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <Globe className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                        )}
                      </div>
                    </div>

                    {/* Domain text */}
                    <span className="flex-1 text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">
                      {domain}
                      {isUrlAnimating && index === 0 && (
                        <span className="animate-pulse text-muted-foreground ml-1">▌</span>
                      )}
                    </span>

                    {/* Kortix loading animation */}
                    <KortixLoader customSize={16} />
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Globe} title={toolTitle} />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && files.length === 0 ? (
          <LoadingState />
        ) : displayUrl || url || files.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 py-0 my-4 space-y-4">
              {/* Scraped URLs */}
              {displayUrls.length > 0 && (
                <>
                  {displayUrls.length > 1 && (
                    <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 mb-3 flex items-center justify-between">
                      <span>Scraped URLs ({displayUrls.length})</span>
                    </div>
                  )}

                  <div className="space-y-2.5">
                    {displayUrls.map((urlItem, idx) => {
                      const domain = formatDomain(urlItem);
                      const favicon = getFavicon(urlItem);

                      return (
                        <div
                          key={idx}
                          className="bg-card border rounded-lg shadow-sm hover:shadow transition-shadow"
                        >
                          <div className="p-4">
                            <div className="flex items-start gap-3">
                              {favicon && (
                                <img
                                  src={favicon}
                                  alt=""
                                  className="w-5 h-5 mt-0.5 rounded flex-shrink-0"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = 'none';
                                  }}
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <Badge variant="outline" className="text-xs px-2 py-0 h-5 font-normal bg-zinc-50 dark:bg-zinc-800">
                                    <Globe className="h-3 w-3 mr-1 opacity-70" />
                                    Website
                                  </Badge>
                                  {actualIsSuccess && !isStreaming && (
                                    <CheckCircle className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400" />
                                  )}
                                </div>
                                <a
                                  href={urlItem}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-md font-medium text-zinc-700 dark:text-zinc-300 hover:underline line-clamp-1 mb-1"
                                >
                                  {truncateString(urlItem, 60)}
                                </a>
                                <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center">
                                  <Globe className="h-3 w-3 mr-1.5 flex-shrink-0 opacity-70" />
                                  {domain}
                                </div>
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 w-8 p-0 flex-shrink-0"
                                asChild
                              >
                                <a href={urlItem} target="_blank" rel="noopener noreferrer">
                                  <ExternalLink className="h-4 w-4" />
                                </a>
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Generated Files Section */}
              {files.length > 0 && (
                <div className="space-y-3">
                  <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 flex items-center justify-between">
                    <span>Generated Files</span>
                    <Badge variant="outline" className="text-xs font-normal">
                      {files.length} {files.length === 1 ? 'file' : 'files'}
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    {files.map((filePath, idx) => {
                      const fileName = getFileName(filePath);
                      const isCopied = copiedFile === filePath;

                      return (
                        <div
                          key={idx}
                          className="group bg-card border rounded-lg shadow-sm hover:shadow transition-shadow"
                        >
                          <div className="p-3.5 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0 border border-zinc-200 dark:border-zinc-700">
                              <FileJson className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                                {fileName}
                              </p>
                              <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                                {filePath}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyFilePath(filePath)}
                              className={cn(
                                "h-8 text-xs opacity-0 group-hover:opacity-100 transition-opacity",
                                isCopied && "opacity-100 text-zinc-600 dark:text-zinc-400"
                              )}
                            >
                              {isCopied ? (
                                <>
                                  <Check className="h-3.5 w-3.5 mr-1.5" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                                  Copy
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <AlertTriangle className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No URL Detected
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center">
              Unable to extract a valid URL from the request
            </p>
          </div>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={actualAssistantTimestamp}
        toolTimestamp={actualToolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          <>
            {files.length > 0 ? (
              <Badge variant="outline" className="h-6 py-0.5">
                <FileJson className="h-3 w-3 mr-1" />
                {files.length} {files.length === 1 ? 'file' : 'files'}
              </Badge>
            ) : displayUrls.length > 0 && actualIsSuccess && (
              <Badge variant="outline" className="h-6 py-0.5">
                <Globe className="h-3 w-3 mr-1" />
                {displayUrls.length} {displayUrls.length === 1 ? 'URL' : 'URLs'} scraped
              </Badge>
            )}
          </>
        )}
      </ToolViewFooter>
    </Card>
  );
}
