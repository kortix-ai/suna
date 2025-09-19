import React, { useState } from 'react';
import {
  Search,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Image as ImageIcon,
  Globe,
  FileText,
  Clock,
  BookOpen,
  CalendarDays,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { cleanUrl, formatTimestamp, getToolTitle } from '../utils';
import { truncateString } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { extractWebSearchData } from './_utils';

export function WebSearchToolView({
  name = 'web-search',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [expandedResults, setExpandedResults] = useState<Record<number, boolean>>({});

  const {
    query,
    searchResults,
    answer,
    images,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractWebSearchData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const getFavicon = (url: string) => {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch (e) {
      return null;
    }
  };

  const getResultType = (result: any) => {
    const { url, title } = result;

    if (url.includes('news') || url.includes('article') || title.includes('News')) {
      return { icon: FileText, label: 'Article' };
    } else if (url.includes('wiki')) {
      return { icon: BookOpen, label: 'Wiki' };
    } else if (url.includes('blog')) {
      return { icon: CalendarDays, label: 'Blog' };
    } else {
      return { icon: Globe, label: 'Website' };
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <Search className="w-5 h-5 text-blue-500 dark:text-blue-400" />
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
              {actualIsSuccess ? 'Search completed successfully' : 'Search failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && searchResults.length === 0 && !answer ? (
          <LoadingState
            icon={Search}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Searching the web"
            filePath={query}
            showProgress={true}
          />
        ) : searchResults.length > 0 || answer ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 py-0 my-4">
              {images.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 flex items-center">
                    <ImageIcon className="h-4 w-4 mr-2 opacity-70" />
                    Images {name === 'image-search' && `(${images.length})`}
                  </h3>
                  <div className={`grid gap-3 mb-1 ${name === 'image-search' ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
                    {(name === 'image-search' ? images : images.slice(0, 6)).map((image, idx) => {
                      const imageUrl = typeof image === 'string' ? image : (image as any).imageUrl;
                      
                      return (
                        <a
                          key={idx}
                          href={imageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group relative overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 hover:border-blue-300 dark:hover:border-blue-700 transition-colors shadow-sm hover:shadow-md"
                        >
                          <img
                            src={imageUrl}
                            alt={`Search result ${idx + 1}`}
                            className="object-cover w-full h-32 group-hover:opacity-90 transition-opacity"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2' ry='2'%3E%3C/rect%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'%3E%3C/circle%3E%3Cpolyline points='21 15 16 10 5 21'%3E%3C/polyline%3E%3C/svg%3E";
                              target.classList.add("p-4");
                            }}
                          />
                          <div className="absolute top-0 right-0 p-1">
                            <Badge variant="secondary" className="bg-black/60 hover:bg-black/70 text-white border-none shadow-md">
                              <ExternalLink className="h-3 w-3" />
                            </Badge>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                  {name !== 'image-search' && images.length > 6 && (
                    <Button variant="outline" size="sm" className="mt-2 text-xs">
                      View {images.length - 6} more images
                    </Button>
                  )}
                </div>
              )}

              {searchResults.length > 0 && name !== 'image-search' && (
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 mb-4 flex items-center justify-between">
                  <span>Search Results ({searchResults.length})</span>
                  <Badge variant="outline" className="text-xs font-normal">
                    <Clock className="h-3 w-3 mr-1.5 opacity-70" />
                    {new Date().toLocaleDateString()}
                  </Badge>
                </div>
              )}

              {name !== 'image-search' && (
                <div className="space-y-4">
                  {searchResults.map((result, idx) => {
                  const { icon: ResultTypeIcon, label: resultTypeLabel } = getResultType(result);
                  const isExpanded = expandedResults[idx] || false;
                  const favicon = getFavicon(result.url);

                  return (
                    <div
                      key={idx}
                      className="bg-card border rounded-lg shadow-sm hover:shadow transition-shadow"
                    >
                      <div className="p-4">
                        <div className="flex items-start gap-3 mb-2">
                          {favicon && (
                            <img
                              src={favicon}
                              alt=""
                              className="w-5 h-5 mt-1 rounded"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant="outline" className="text-xs px-2 py-0 h-5 font-normal bg-zinc-50 dark:bg-zinc-800">
                                <ResultTypeIcon className="h-3 w-3 mr-1 opacity-70" />
                                {resultTypeLabel}
                              </Badge>
                            </div>
                            <a
                              href={result.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-md font-medium text-blue-600 dark:text-blue-400 hover:underline line-clamp-1 mb-1"
                            >
                              {truncateString(cleanUrl(result.title), 50)}
                            </a>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2 flex items-center">
                              <Globe className="h-3 w-3 mr-1.5 flex-shrink-0 opacity-70" />
                              {truncateString(cleanUrl(result.url), 70)}
                            </div>
                          </div>
                          {/* <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0 rounded-full"
                                  onClick={() => toggleExpand(idx)}
                                >
                                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{isExpanded ? 'Show less' : 'Show more'}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider> */}
                        </div>

                        {/* {result.snippet && (
                          <div className={cn(
                            "text-sm text-zinc-600 dark:text-zinc-400",
                            isExpanded ? "whitespace-pre-wrap break-words max-h-96 overflow-y-auto" : "line-clamp-2"
                          )}>
                            {isExpanded ? (
                              // When expanded, preserve line breaks and show full content
                              result.snippet
                                ?.replace(/\\\\\n/g, '\n')
                                ?.replace(/\\\\n/g, '\n')
                                ?.replace(/\\n/g, '\n')
                                ?.replace(/\\\\\t/g, '\t')
                                ?.replace(/\\\\t/g, '\t')
                                ?.replace(/\\t/g, '\t')
                                ?.replace(/\\\\\r/g, '\r')
                                ?.replace(/\\\\r/g, '\r')
                                ?.replace(/\\r/g, '\r')
                                ?.trim()
                            ) : (
                              // When collapsed, convert to single line
                              result.snippet
                                ?.replace(/\\\\\n/g, ' ')
                                ?.replace(/\\\\n/g, ' ')
                                ?.replace(/\\n/g, ' ')
                                ?.replace(/\\\\\t/g, ' ')
                                ?.replace(/\\\\t/g, ' ')
                                ?.replace(/\\t/g, ' ')
                                ?.replace(/\\\\\r/g, ' ')
                                ?.replace(/\\\\r/g, ' ')
                                ?.replace(/\\r/g, ' ')
                                ?.replace(/\s+/g, ' ')
                                ?.trim()
                            )}
                          </div>
                        )} */}
                      </div>

                      {isExpanded && (
                        <div className="bg-zinc-50 px-4 dark:bg-zinc-800/50 border-t border-zinc-200 dark:border-zinc-800 p-3 flex justify-between items-center">
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            Source: {cleanUrl(result.url)}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs bg-white dark:bg-zinc-900"
                            asChild
                          >
                            <a href={result.url} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-3 w-3" />
                              Visit Site
                            </a>
                          </Button>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <Search className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Results Found
            </h3>
            <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full max-w-md text-center mb-4 shadow-sm">
              <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
                {query || 'Unknown query'}
              </code>
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Try refining your search query for better results
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && (
            <>
              {name === 'image-search' && images.length > 0 && (
                <Badge variant="outline" className="h-6 py-0.5">
                  <ImageIcon className="h-3 w-3" />
                  {images.length} images
                </Badge>
              )}
              {name !== 'image-search' && searchResults.length > 0 && (
                <Badge variant="outline" className="h-6 py-0.5">
                  <Globe className="h-3 w-3" />
                  {searchResults.length} results
                </Badge>
              )}
            </>
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