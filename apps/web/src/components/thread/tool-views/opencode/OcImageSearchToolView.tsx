'use client';

import React, { useMemo, useState } from 'react';
import {
  Image as ImageIcon,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  Maximize2,
  Search,
  AlertTriangle,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ImageResult {
  url?: string;
  imageUrl?: string;
  image_url?: string;
  title?: string;
  width?: number;
  height?: number;
  description?: string;
  source?: string;
}

interface BatchItem {
  query: string;
  total: number;
  images: ImageResult[];
  success: boolean;
}

const IMAGE_FALLBACK_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2' ry='2'%3E%3C/rect%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'%3E%3C/circle%3E%3Cpolyline points='21 15 16 10 5 21'%3E%3C/polyline%3E%3C/svg%3E";

function normalizeImage(img: any): ImageResult | null {
  if (!img) return null;
  if (typeof img === 'string') return { url: img };
  const url = img.url || img.imageUrl || img.image_url || '';
  if (!url) return null;
  return {
    url,
    imageUrl: img.imageUrl,
    title: img.title || '',
    width: img.width || img.imageWidth || 0,
    height: img.height || img.imageHeight || 0,
    description: img.description || '',
    source: img.source || img.link || '',
  };
}

interface ParsedOutput {
  isBatch: boolean;
  batchItems: BatchItem[];
  images: ImageResult[];
}

function parseOutput(output: unknown): ParsedOutput {
  const empty: ParsedOutput = { isBatch: false, batchItems: [], images: [] };
  if (!output) return empty;

  let obj: any = output;
  if (typeof output === 'string') {
    try {
      obj = JSON.parse(output);
    } catch {
      return empty;
    }
  }

  if (!obj || typeof obj !== 'object') return empty;

  // Handle batch mode: { batch_mode: true, results: [{ query, total, images }] }
  if (obj.batch_mode === true && Array.isArray(obj.results)) {
    const batchItems: BatchItem[] = obj.results.map((item: any) => ({
      query: item.query || '',
      total: item.total || 0,
      success: item.success !== false,
      images: Array.isArray(item.images)
        ? item.images.map(normalizeImage).filter((i: ImageResult | null): i is ImageResult => i !== null)
        : [],
    }));
    const allImages = batchItems.flatMap(b => b.images);
    return { isBatch: true, batchItems, images: allImages };
  }

  // Handle legacy batch_results format
  if (obj.batch_results && Array.isArray(obj.batch_results)) {
    const batchItems: BatchItem[] = obj.batch_results.map((item: any) => ({
      query: item.query || '',
      total: item.total || 0,
      success: item.success !== false,
      images: Array.isArray(item.images)
        ? item.images.map(normalizeImage).filter((i: ImageResult | null): i is ImageResult => i !== null)
        : [],
    }));
    const allImages = batchItems.flatMap(b => b.images);
    return { isBatch: true, batchItems, images: allImages };
  }

  // Handle single result: { images: [...] } or { results: [...] } or array
  let images: ImageResult[] = [];
  if (Array.isArray(obj.images)) {
    images = obj.images.map(normalizeImage).filter((i: ImageResult | null): i is ImageResult => i !== null);
  } else if (Array.isArray(obj.results)) {
    images = obj.results.map(normalizeImage).filter((i: ImageResult | null): i is ImageResult => i !== null);
  } else if (Array.isArray(obj)) {
    images = obj.map(normalizeImage).filter((i: ImageResult | null): i is ImageResult => i !== null);
  }
  return { isBatch: false, batchItems: [], images };
}

function getImageUrl(img: ImageResult): string {
  return img.url || img.imageUrl || img.image_url || '';
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

export function OcImageSearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [currentQueryIndex, setCurrentQueryIndex] = useState(0);

  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const query = (ocState?.input?.query as string) || (args.query as string) || '';
  const numResults = (ocState?.input?.num_results as number) || (args.num_results as number) || 0;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const isError = toolResult?.success === false || !!toolResult?.error;

  const { isBatch, batchItems, images: allImages } = useMemo(() => parseOutput(rawOutput), [rawOutput]);

  const safeQueryIndex = batchItems.length > 0
    ? Math.min(currentQueryIndex, batchItems.length - 1)
    : 0;
  const currentBatch = batchItems[safeQueryIndex];
  const currentImages = isBatch && currentBatch ? currentBatch.images : allImages;
  const totalImages = isBatch ? batchItems.reduce((n, b) => n + b.images.length, 0) : allImages.length;

  const headerSubtitle = isBatch && batchItems.length > 1
    ? `${batchItems.length} queries`
    : query;

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Image Search"
        subtitle={query || 'Searching...'}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={ImageIcon} title="Image Search" subtitle={headerSubtitle} />
          {totalImages > 0 && (
            <Badge
              variant="outline"
              className="h-5 py-0 text-[10px] bg-muted text-muted-foreground"
            >
              {totalImages} image{totalImages !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3">
            {/* Batch query tabs */}
            {isBatch && batchItems.length > 1 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {batchItems.map((bi, idx) => {
                  const isActive = idx === safeQueryIndex;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setCurrentQueryIndex(idx)}
                      className={`
                        inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11.5px] font-medium tracking-tight transition-colors
                        ${isActive
                          ? 'bg-foreground/[0.06] text-foreground border border-border/50'
                          : 'bg-transparent text-muted-foreground/80 hover:text-foreground hover:bg-foreground/[0.03] border border-transparent'
                        }
                      `}
                    >
                      <Search className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate max-w-[180px]">{bi.query}</span>
                      {bi.images.length > 0 && (
                        <span className="text-[10px] text-muted-foreground/60">
                          {bi.images.length}
                        </span>
                      )}
                      {bi.success ? (
                        <CheckCircle className="w-3 h-3 text-foreground/60" />
                      ) : (
                        <AlertTriangle className="w-3 h-3 text-foreground/60" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Single batch header */}
            {isBatch && batchItems.length === 1 && currentBatch && (
              <div className="flex items-center gap-2 mb-3 px-1">
                <ImageIcon className="size-3.5 text-muted-foreground/80 flex-shrink-0" />
                <span className="text-xs text-muted-foreground truncate">
                  &quot;{currentBatch.query}&quot;
                </span>
                {currentBatch.success ? (
                  <CheckCircle className="size-3.5 text-foreground/60" />
                ) : (
                  <AlertTriangle className="size-3.5 text-foreground/60" />
                )}
              </div>
            )}

            {/* Single query info (non-batch) */}
            {!isBatch && query && (
              <div className="flex items-center gap-2 mb-3 px-1">
                <ImageIcon className="size-3.5 text-muted-foreground/80 flex-shrink-0" />
                <span className="text-xs text-muted-foreground truncate">
                  &quot;{query}&quot;
                </span>
                {numResults > 0 && (
                  <span className="text-[10px] text-muted-foreground/60 ml-auto flex-shrink-0">
                    {numResults} requested
                  </span>
                )}
              </div>
            )}

            {/* Error state */}
            {isError && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/[0.04]">
                <AlertCircle className="w-3.5 h-3.5 text-red-500/90 flex-shrink-0" />
                <span className="text-[12px] text-foreground/85 tracking-tight">
                  {typeof rawOutput === 'string' ? rawOutput : 'Image search failed'}
                </span>
              </div>
            )}

            {/* No images state */}
            {!isError && !isStreaming && currentImages.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                <ImageIcon className="size-8 opacity-40" />
                <span className="text-xs">No images found</span>
                {query && (
                  <span className="text-[10px] opacity-60">
                    Try a different search query
                  </span>
                )}
              </div>
            )}

            {/* Image grid */}
            {currentImages.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {currentImages.map((img, idx) => {
                  const imageUrl = getImageUrl(img);
                  if (!imageUrl) return null;
                  const hasDimensions =
                    img.width && img.height && img.width > 0 && img.height > 0;
                  const orientation = hasDimensions
                    ? img.width! > img.height!
                      ? 'landscape'
                      : img.width! < img.height!
                        ? 'portrait'
                        : 'square'
                    : null;

                  return (
                    <TooltipProvider key={idx}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            href={imageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group relative overflow-hidden rounded-lg border border-border bg-muted hover:border-violet-300 dark:hover:border-violet-700 transition-colors shadow-sm hover:shadow-md"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={imageUrl}
                              alt={img.title || `Image ${idx + 1}`}
                              className="object-cover w-full h-32 group-hover:opacity-90 transition-opacity"
                              loading="lazy"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.src = IMAGE_FALLBACK_SVG;
                                target.classList.add('p-4');
                              }}
                            />
                            {/* Metadata badges */}
                            <div className="absolute top-0 left-0 right-0 p-1 flex justify-between items-start">
                              <div className="flex gap-1">
                                {hasDimensions && (
                                  <Badge
                                    variant="secondary"
                                    className="bg-black/60 hover:bg-black/70 text-white border-none shadow-md text-[10px] px-1.5 py-0"
                                  >
                                    <Maximize2 className="h-2.5 w-2.5 mr-0.5" />
                                    {img.width}&times;{img.height}
                                  </Badge>
                                )}
                              </div>
                              <Badge
                                variant="secondary"
                                className="bg-black/60 hover:bg-black/70 text-white border-none shadow-md"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </Badge>
                            </div>
                            {/* Title at bottom */}
                            {(img.title || img.source) && (
                              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-4">
                                <p className="text-[10px] text-white/90 truncate leading-tight">
                                  {img.title || img.source}
                                </p>
                              </div>
                            )}
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs">
                          <div className="space-y-1.5">
                            {img.title && (
                              <p className="font-medium text-sm">
                                {truncate(img.title, 80)}
                              </p>
                            )}
                            {hasDimensions && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1">
                                <Maximize2 className="h-3 w-3" />
                                {img.width} &times; {img.height}px
                                {orientation && (
                                  <span className="text-xs">({orientation})</span>
                                )}
                              </p>
                            )}
                            {img.description && (
                              <p className="text-xs text-muted-foreground">
                                {truncate(img.description, 150)}
                              </p>
                            )}
                            {img.source && (
                              <p className="text-xs text-muted-foreground truncate">
                                Source: {img.source}
                              </p>
                            )}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming &&
          (isError ? (
            <Badge
              variant="outline"
              className="h-6 py-0.5 bg-muted text-muted-foreground"
            >
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : totalImages > 0 ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              {isBatch && batchItems.length > 1
                ? `${batchItems.length} queries, ${totalImages} images`
                : `${totalImages} image${totalImages !== 1 ? 's' : ''}`
              }
            </Badge>
          ) : null)}
      </ToolViewFooter>
    </Card>
  );
}
