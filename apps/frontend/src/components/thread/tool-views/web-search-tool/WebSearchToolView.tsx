import React, { useState, useEffect } from 'react';
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
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Type,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { cleanUrl, formatTimestamp, getToolTitle } from '../utils';
import { truncateString } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { WebSearchLoadingState } from './WebSearchLoadingState';
import { extractWebSearchData, EnrichedImage } from './_utils';
import { useSmoothToolField } from '@/hooks/messages';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function WebSearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [expandedResults, setExpandedResults] = useState<Record<number, boolean>>({});
  const [currentQueryIndex, setCurrentQueryIndex] = useState(0);

  // Apply smooth text streaming for query field
  const rawArguments = toolCall?.rawArguments || toolCall?.arguments;
  const smoothFields = useSmoothToolField(
    typeof rawArguments === 'object' && rawArguments ? rawArguments : {},
    { interval: 50 }
  );
  const smoothQuery = (smoothFields as any).query || (typeof rawArguments === 'object' ? rawArguments?.query : '') || '';
  const isQueryAnimating = isStreaming && !toolResult;

  const {
    query,
    searchResults,
    answer,
    images,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp,
    isBatch,
    batchResults
  } = extractWebSearchData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  // Use smooth query when streaming
  const displayQuery = isStreaming && smoothQuery ? smoothQuery : query;

  // Reset to first query when batch results change
  useEffect(() => {
    if (isBatch && batchResults && batchResults.length > 0) {
      setCurrentQueryIndex(0);
    }
  }, [isBatch, batchResults?.length]);

  // Ensure currentQueryIndex is always valid - computed value with bounds checking
  const safeQueryIndex = batchResults && batchResults.length > 0 
    ? Math.min(currentQueryIndex, batchResults.length - 1)
    : 0;
  
  // Get the current batch item safely
  const currentBatchItem = batchResults?.[safeQueryIndex];

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  const getFavicon = (url: string | undefined) => {
    if (!url) {
      return null;
    }
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch (e) {
      return null;
    }
  };

  const getResultType = (result: any) => {
    const { url, title } = result;
    
    // Guard against undefined/null values
    if (!url || !title) {
      return { icon: Globe, label: 'Website' };
    }

    const urlLower = url.toLowerCase();
    const titleLower = title.toLowerCase();

    if (urlLower.includes('news') || urlLower.includes('article') || titleLower.includes('news')) {
      return { icon: FileText, label: 'Article' };
    } else if (urlLower.includes('wiki')) {
      return { icon: BookOpen, label: 'Wiki' };
    } else if (urlLower.includes('blog')) {
      return { icon: CalendarDays, label: 'Blog' };
    } else {
      return { icon: Globe, label: 'Website' };
    }
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Search} title={toolTitle} />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && searchResults.length === 0 && !answer && images.length === 0 ? (
          <WebSearchLoadingState
            queries={
              // Parse queries from toolCall arguments
              (() => {
                const args = toolCall?.arguments || {};
                const rawQuery = args.query || args.queries;
                if (Array.isArray(rawQuery)) {
                  return rawQuery.filter((q): q is string => typeof q === 'string');
                }
                if (typeof rawQuery === 'string') {
                  // Try to parse as JSON array
                  try {
                    const parsed = JSON.parse(rawQuery);
                    if (Array.isArray(parsed)) {
                      return parsed.filter((q): q is string => typeof q === 'string');
                    }
                  } catch {
                    // Not JSON, treat as single query
                  }
                  return [rawQuery];
                }
                return query ? [query] : ['Searching...'];
              })()
            }
            title={name === 'image-search' ? "Searching for images" : "Searching the web"}
          />
        ) : searchResults.length > 0 || answer || images.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 py-0 my-4">
              {/* Navigation Header - At the absolute top */}
              {isBatch && batchResults && currentBatchItem && (
                <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        Query {safeQueryIndex + 1} of {batchResults.length}
                      </span>
                      {currentBatchItem.success ? (
                        <CheckCircle className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400" />
                      )}
                      {name === 'image-search' && currentBatchItem.images?.length > 0 && (
                        <Badge variant="outline" className="text-xs font-normal h-4 px-1.5">
                          {currentBatchItem.images.length} images
                        </Badge>
                      )}
                      {name !== 'image-search' && currentBatchItem.results?.length > 0 && (
                        <Badge variant="outline" className="text-xs font-normal h-4 px-1.5">
                          {currentBatchItem.results.length}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm font-medium text-foreground truncate">
                      {currentBatchItem.query}
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-1 ml-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => setCurrentQueryIndex(Math.max(0, safeQueryIndex - 1))}
                      disabled={safeQueryIndex === 0}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => setCurrentQueryIndex(Math.min(batchResults.length - 1, safeQueryIndex + 1))}
                      disabled={safeQueryIndex === batchResults.length - 1}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              {images.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 flex items-center">
                    <ImageIcon className="h-4 w-4 mr-2 opacity-70" />
                    Images {name === 'image-search' && isBatch && currentBatchItem
                      ? `(${currentBatchItem.images?.length || 0})`
                      : name === 'image-search'
                        ? `(${images.length})`
                        : ''}
                    {isBatch && batchResults && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (Query {safeQueryIndex + 1} of {batchResults.length})
                      </span>
                    )}
                  </h3>
                  <div className={`grid gap-3 mb-1 ${name === 'image-search' ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
                    {(() => {
                      // Show images for current query if batch mode, otherwise all images
                      const imagesToShow: EnrichedImage[] = isBatch && currentBatchItem?.images
                        ? currentBatchItem.images
                        : (name === 'image-search' ? images : images.slice(0, 6));
                      return imagesToShow.map((image, idx) => {
                      const imageUrl = image.url || image.imageUrl || '';
                      const hasDescription = image.description && image.description.trim().length > 0;
                      const hasDimensions = image.width && image.height && image.width > 0 && image.height > 0;
                      const orientation = hasDimensions 
                        ? (image.width! > image.height! ? 'landscape' : image.width! < image.height! ? 'portrait' : 'square')
                        : null;
                      
                      return (
                        <TooltipProvider key={idx}>
                          <Tooltip>
                            
                            <TooltipTrigger asChild>
                              <a
                                href={imageUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="group relative overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 hover:border-blue-300 dark:hover:border-blue-700 transition-colors shadow-sm hover:shadow-md"
                              >
                                <img
                                  src={imageUrl}
                                  alt={image.title || `Search result ${idx + 1}`}
                                  className="object-cover w-full h-32 group-hover:opacity-90 transition-opacity"
                                  onError={(e) => {
                                    const target = e.target as HTMLImageElement;
                                    target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2' ry='2'%3E%3C/rect%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'%3E%3C/circle%3E%3Cpolyline points='21 15 16 10 5 21'%3E%3C/polyline%3E%3C/svg%3E";
                                    target.classList.add("p-4");
                                  }}
                                />
                                {/* Metadata badges overlay */}
                                <div className="absolute top-0 left-0 right-0 p-1 flex justify-between items-start">
                                  <div className="flex gap-1">
                                    {hasDimensions && (
                                      <Badge variant="secondary" className="bg-black/60 hover:bg-black/70 text-white border-none shadow-md text-[10px] px-1.5 py-0">
                                        <Maximize2 className="h-2.5 w-2.5 mr-0.5" />
                                        {image.width}×{image.height}
                                      </Badge>
                                    )}
                                    {hasDescription && (
                                      <Badge variant="secondary" className="bg-emerald-600/80 hover:bg-emerald-600/90 text-white border-none shadow-md text-[10px] px-1.5 py-0">
                                        <Type className="h-2.5 w-2.5" />
                                      </Badge>
                                    )}
                                  </div>
                                  <Badge variant="secondary" className="bg-black/60 hover:bg-black/70 text-white border-none shadow-md">
                                    <ExternalLink className="h-3 w-3" />
                                  </Badge>
                                </div>
                                {/* Title/source at bottom */}
                                {(image.title || image.source) && (
                                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-4">
                                    <p className="text-[10px] text-white/90 truncate leading-tight">
                                      {image.title || image.source}
                                    </p>
                                  </div>
                                )}
                              </a>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-xs">
                              <div className="space-y-1.5">
                                {image.title && (
                                  <p className="font-medium text-sm">{truncateString(image.title, 60)}</p>
                                )}
                                {hasDimensions && (
                                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                                    <Maximize2 className="h-3 w-3" />
                                    {image.width} × {image.height}px
                                    {orientation && <span className="text-xs">({orientation})</span>}
                                  </p>
                                )}
                                {hasDescription && (
                                  <div className="text-xs">
                                    <p className="text-muted-foreground flex items-center gap-1 mb-0.5">
                                      <Type className="h-3 w-3" /> Description:
                                    </p>
                                    <p className="text-foreground bg-muted/50 rounded px-1.5 py-1 font-mono text-[10px] max-h-20 overflow-auto">
                                      {truncateString(image.description || '', 150)}
                                    </p>
                                  </div>
                                )}
                                {image.source && (
                                  <p className="text-xs text-muted-foreground">Source: {image.source}</p>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      );
                    });
                    })()}
                  </div>
                  {name !== 'image-search' && (() => {
                    const currentImages = isBatch && currentBatchItem?.images
                      ? currentBatchItem.images
                      : images;
                    return currentImages.length > 6 && (
                    <Button variant="outline" size="sm" className="mt-2 text-xs">
                        View {currentImages.length - 6} more images
                    </Button>
                    );
                  })()}
                </div>
              )}

              {name !== 'image-search' && (
                <>
                  {isBatch && batchResults && currentBatchItem ? (
                    // Batch mode: display current query results
                    <div className="space-y-4">
                      {/* Current Query Results */}
                      {(() => {
                        return (
                          <div className="space-y-4">
                            {currentBatchItem.answer && (
                              <div className="bg-muted/50 border border-border rounded-lg p-3">
                                <p className="text-sm text-foreground leading-relaxed">
                                  {currentBatchItem.answer}
                                </p>
                              </div>
                            )}

                            {currentBatchItem.results?.length > 0 ? (
                              <div className="space-y-2.5">
                                {currentBatchItem.results.map((result, idx) => {
                                  // Guard against missing url/title
                                  if (!result?.url || !result?.title) {
                                    return null;
                                  }
                                  
                                  const { icon: ResultTypeIcon, label: resultTypeLabel } = getResultType(result);
                                  const resultKey = `batch-${safeQueryIndex}-result-${idx}`;
                                  const isExpanded = expandedResults[resultKey] || false;
                                  const favicon = getFavicon(result.url);

                                  return (
                                    <div
                                      key={resultKey}
                                      className="bg-card border border-border rounded-lg hover:border-border/80 transition-colors"
                                    >
                                      <div className="p-3.5">
                                        <div className="flex items-start gap-2.5">
                                          {favicon && (
                                            <img
                                              src={favicon}
                                              alt=""
                                              className="w-4 h-4 mt-0.5 rounded flex-shrink-0"
                                              onError={(e) => {
                                                (e.target as HTMLImageElement).style.display = 'none';
                                              }}
                                            />
                                          )}
                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 mb-1">
                                              <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                                                <ResultTypeIcon className="h-2.5 w-2.5 mr-1 opacity-70" />
                                                {resultTypeLabel}
                                              </Badge>
                                            </div>
                                            <a
                                              href={result.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-sm font-medium text-primary hover:underline line-clamp-1 mb-1 block"
                                            >
                                              {truncateString(cleanUrl(result.title), 60)}
                                            </a>
                                            <div className="text-xs text-muted-foreground flex items-center">
                                              <Globe className="h-3 w-3 mr-1 flex-shrink-0 opacity-60" />
                                              <span className="truncate">{truncateString(cleanUrl(result.url), 65)}</span>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="text-sm text-muted-foreground italic py-4 text-center">
                                No results found for this query
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    // Single query mode: original display
                    <>
                      {searchResults.length > 0 && (
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 mb-4 flex items-center justify-between">
                  <span>Search Results ({searchResults.length})</span>
                  <Badge variant="outline" className="text-xs font-normal">
                    <Clock className="h-3 w-3 mr-1.5 opacity-70" />
                    {new Date().toLocaleDateString()}
                  </Badge>
                </div>
              )}

                <div className="space-y-4">
                  {searchResults.map((result, idx) => {
                  // Guard against missing url/title
                  if (!result?.url || !result?.title) {
                    return null;
                  }
                  
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
                              className="text-md font-medium text-zinc-700 dark:text-zinc-300 hover:underline line-clamp-1 mb-1"
                            >
                              {truncateString(cleanUrl(result.title), 50)}
                            </a>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2 flex items-center">
                              <Globe className="h-3 w-3 mr-1.5 flex-shrink-0 opacity-70" />
                              {truncateString(cleanUrl(result.url), 70)}
                            </div>
                          </div>
                          </div>
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
                    </>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              {name === 'image-search' ? (
                <ImageIcon className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
              ) : (
              <Search className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
              )}
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {name === 'image-search' ? 'No Images Found' : 'No Results Found'}
            </h3>
            {query && (
            <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full max-w-md text-center mb-4 shadow-sm">
              <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
                  {typeof query === 'string' ? query : Array.isArray(query) ? (query as string[]).join(', ') : 'Unknown query'}
              </code>
            </div>
            )}
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {name === 'image-search' 
                ? 'Try refining your image search query for better results'
                : 'Try refining your search query for better results'}
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
            {name === 'image-search' && (
              <>
                {isBatch && batchResults ? (
                  <Badge variant="outline" className="h-6 py-0.5">
                    <ImageIcon className="h-3 w-3" />
                    {batchResults.length} queries • {images.length} images
                  </Badge>
                ) : images.length > 0 && (
                  <Badge variant="outline" className="h-6 py-0.5">
                    <ImageIcon className="h-3 w-3" />
                    {images.length} images
                  </Badge>
                )}
              </>
            )}
            {name !== 'image-search' && (
              <>
                {isBatch && batchResults ? (
                  <Badge variant="outline" className="h-6 py-0.5">
                    <Globe className="h-3 w-3" />
                    {batchResults.length} queries • {searchResults.length} results
                  </Badge>
                ) : searchResults.length > 0 && (
                  <Badge variant="outline" className="h-6 py-0.5">
                    <Globe className="h-3 w-3" />
                    {searchResults.length} results
                  </Badge>
                )}
              </>
            )}
          </>
        )}
      </ToolViewFooter>
    </Card>
  );
} 