import React, { useState, useEffect } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Loader2,
  Sparkles,
  Edit3,
  Download,
  ZoomIn,
  ZoomOut,
  ImageOff,
  Image as ImageIcon,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { extractImageEditGenerateData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useImageContent } from '@/hooks/files';
import { useDownloadRestriction } from '@/hooks/billing';

interface ImageDisplayProps {
  filePath: string;
  sandboxId?: string;
  label?: string;
  compact?: boolean;
}

function ImageDisplay({ filePath, sandboxId, label, compact = false }: ImageDisplayProps) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'images',
  });
  
  const {
    data: imageUrl,
    isLoading,
    error,
    failureCount,
  } = useImageContent(sandboxId, filePath, {
    enabled: !!sandboxId && !!filePath,
  });

  const handleZoomToggle = () => {
    setIsZoomed(!isZoomed);
    setZoomLevel(1);
  };

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoomLevel(prev => Math.min(prev + 0.25, 3));
    if (!isZoomed) setIsZoomed(true);
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoomLevel(prev => Math.max(prev - 0.25, 0.5));
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!imageUrl) return;

    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = filePath.split('/').pop() || 'image';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isLoading) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center w-full bg-gradient-to-b from-zinc-50 to-zinc-100 dark:from-zinc-900/50 dark:to-zinc-800/30 rounded-xl border",
        compact ? "h-32 p-4" : "h-64 p-8"
      )}>
        <Loader2 className={cn("animate-spin text-primary mb-2", compact ? "h-5 w-5" : "h-8 w-8")} />
        <p className="text-xs text-muted-foreground">Loading...</p>
        {failureCount > 0 && (
          <p className="text-xs text-muted-foreground mt-1">Retry {failureCount + 1}</p>
        )}
      </div>
    );
  }

  if (error && !isLoading && failureCount >= 15) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center w-full bg-gradient-to-b from-rose-50 to-rose-100 dark:from-rose-950/30 dark:to-rose-900/20 rounded-xl border border-rose-200 dark:border-rose-800",
        compact ? "h-32 p-4" : "h-64 p-8"
      )}>
        <ImageOff className={cn("text-rose-500 mb-2", compact ? "h-5 w-5" : "h-8 w-8")} />
        <p className="text-xs text-rose-600 dark:text-rose-400 text-center break-all max-w-[200px]">
          {filePath.split('/').pop()}
        </p>
      </div>
    );
  }

  if (!imageUrl) return null;

  return (
    <div className="flex flex-col">
      {label && (
        <Badge variant="secondary" className="text-xs mb-2 w-fit">
          {label}
        </Badge>
      )}
      
      <div className={cn(
        "overflow-hidden rounded-xl border bg-card transition-all duration-300",
        isZoomed ? "cursor-zoom-out" : "cursor-zoom-in"
      )}>
        <img
          src={imageUrl}
          alt={filePath}
          onClick={handleZoomToggle}
          className={cn(
            "w-full object-contain transition-all duration-300 ease-in-out",
            isZoomed ? "max-h-[80vh]" : compact ? "max-h-[200px]" : "max-h-[500px]",
            !isZoomed && "hover:scale-[1.01]"
          )}
          style={{ transform: isZoomed ? `scale(${zoomLevel})` : 'none' }}
        />
      </div>

      {!compact && (
        <div className="flex items-center justify-between w-full px-2 py-2 mt-2 bg-zinc-50 dark:bg-zinc-900 rounded-xl border">
          <Badge variant="secondary" className="text-xs">
            <ImageIcon className="h-3 w-3 mr-1" />
            {filePath.split('.').pop()?.toUpperCase()}
          </Badge>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomOut} disabled={zoomLevel <= 0.5}>
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs font-mono px-1 min-w-8 text-center">{Math.round(zoomLevel * 100)}%</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomIn} disabled={zoomLevel >= 3}>
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <div className="w-px h-4 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleDownload} title="Download">
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ImageEditGenerateToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

export function ImageEditGenerateToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ImageEditGenerateToolViewProps) {
  const [progress, setProgress] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (isStreaming) {
      const timer = setInterval(() => {
        setProgress(prev => prev >= 95 ? prev : prev + 5);
      }, 300);
      return () => clearInterval(timer);
    } else {
      setProgress(100);
    }
  }, [isStreaming]);

  if (!toolCall) return null;

  const {
    mode,
    prompt,
    generatedImagePaths,
    status,
    error,
    isBatch,
    batchResults,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp,
  } = extractImageEditGenerateData(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);

  const sandboxId = project?.sandbox?.id;
  const isGenerate = mode === 'generate';
  const isEdit = mode === 'edit';
  const totalImages = generatedImagePaths.length;
  const successCount = batchResults.filter(r => r.success).length;
  const failedCount = batchResults.filter(r => !r.success).length;
  
  // Current batch item
  const currentResult = batchResults[currentIndex];

  // Truncate prompt for header
  const shortPrompt = prompt && prompt.length > 60 ? `${prompt.substring(0, 60)}...` : prompt;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-zinc-900">
      {/* Header */}
      <div className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 flex items-center justify-between flex-shrink-0 max-w-full min-w-0">
        <div className="flex items-center gap-3 overflow-x-auto min-w-0 scrollbar-hide max-w-full">
          <div className={cn(
            "relative p-2 rounded-lg border flex-shrink-0 transition-colors",
            "bg-zinc-900 border-zinc-700"
          )}>
            {isGenerate ? (
              <Sparkles className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
            ) : (
              <Edit3 className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
            )}
          </div>
          <div>
            <div className="text-base font-medium text-zinc-900 dark:text-zinc-100">
              {isGenerate ? 'Image Generation' : 'Image Editing'}
              {totalImages > 1 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({totalImages} images)
                </span>
              )}
            </div>
            {shortPrompt && (
              <p className="text-xs text-muted-foreground mt-0.5 max-w-md truncate">
                {shortPrompt}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          {!isStreaming ? (
            <Badge 
              variant="secondary" 
              className={cn(
                "px-2.5 py-1 flex items-center gap-1.5",
                actualIsSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              )}
            >
              {actualIsSuccess ? <CheckCircle className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {actualIsSuccess ? 'Success' : 'Failed'}
            </Badge>
          ) : (
            <Badge className={cn(
              "px-2.5 py-1 flex items-center gap-1.5",
              isGenerate
                ? "bg-gradient-to-b from-purple-50 to-purple-100 text-purple-700 border border-purple-200/50 dark:from-purple-900/30 dark:to-purple-800/20 dark:text-purple-400 dark:border-purple-800/30"
                : "bg-gradient-to-b from-blue-50 to-blue-100 text-blue-700 border border-blue-200/50 dark:from-blue-900/30 dark:to-blue-800/20 dark:text-blue-400 dark:border-blue-800/30"
            )}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {isGenerate ? 'Generating...' : 'Editing...'}
            </Badge>
          )}
        </div>
      </div>

      {/* Content */}
      <CardContent className="p-0 flex-1 overflow-hidden">
        {isStreaming && batchResults.length === 0 ? (
          /* Loading State */
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] p-8 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="text-center w-full max-w-xs">
              <div className="space-y-3 mb-6">
                <Skeleton className="h-12 w-12 rounded-full mx-auto" />
                <Skeleton className="h-5 w-32 mx-auto" />
                <Skeleton className="h-4 w-48 mx-auto" />
              </div>
              <Skeleton className="h-48 w-full rounded-xl mb-6" />
              <div className="w-full h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300 ease-out",
                    isGenerate
                      ? "bg-gradient-to-r from-purple-400 to-purple-500"
                      : "bg-gradient-to-r from-blue-400 to-blue-500"
                  )}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-2">{progress}%</p>
            </div>
          </div>
        ) : batchResults.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4">
              {/* Batch Navigation Header */}
              {isBatch && (
                <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        Image {currentIndex + 1} of {batchResults.length}
                      </span>
                      {currentResult?.success ? (
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
                      )}
                    </div>
                    <p className="text-sm font-medium text-foreground line-clamp-2">
                      {currentResult?.prompt}
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-1 ml-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => setCurrentIndex(Math.min(batchResults.length - 1, currentIndex + 1))}
                      disabled={currentIndex === batchResults.length - 1}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Current Result Display */}
              {currentResult && (
                <div className="space-y-4">
                  {currentResult.success && currentResult.imageFilename ? (
                    /* Success: Show Image */
                    <div className="space-y-4">
                      {/* Edit mode: show input → output */}
                      {isEdit && currentResult.inputImagePath ? (
                        <div className="flex items-stretch gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-muted-foreground mb-2">Original</p>
                            <ImageDisplay
                              filePath={currentResult.inputImagePath}
                              sandboxId={sandboxId}
                              compact
                            />
                          </div>
                          <div className="flex items-center justify-center px-2">
                            <ArrowRight className="h-5 w-5 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-muted-foreground mb-2">Result</p>
                            <ImageDisplay
                              filePath={currentResult.imageFilename}
                              sandboxId={sandboxId}
                              compact
                            />
                          </div>
                        </div>
                      ) : (
                        /* Generate mode: show just the output */
                        <ImageDisplay
                          filePath={currentResult.imageFilename}
                          sandboxId={sandboxId}
                        />
                      )}
                      
                      {/* Prompt for single mode */}
                      {!isBatch && currentResult.prompt && (
                        <div className="p-3 rounded-lg bg-muted/50 border">
                          <p className="text-xs font-medium text-muted-foreground mb-1">Prompt</p>
                          <p className="text-sm text-foreground">{currentResult.prompt}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Failure: Show Error */
                    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-rose-100 to-rose-50 dark:from-rose-800/40 dark:to-rose-900/60">
                        <AlertTriangle className="h-8 w-8 text-rose-500 dark:text-rose-400" />
                      </div>
                      <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                        Processing Failed
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mb-4">
                        {currentResult.error || 'An error occurred during processing.'}
                      </p>
                      {!isBatch && currentResult.prompt && (
                        <div className="p-3 rounded-lg bg-muted/50 border max-w-md w-full">
                          <p className="text-xs font-medium text-muted-foreground mb-1">Prompt</p>
                          <p className="text-sm text-foreground break-words">{currentResult.prompt}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          /* No Results State */
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] p-8 text-center">
            <div className={cn(
              "w-16 h-16 rounded-full flex items-center justify-center mb-4",
              isGenerate
                ? "bg-gradient-to-b from-purple-100 to-purple-50 dark:from-purple-800/40 dark:to-purple-900/60"
                : "bg-gradient-to-b from-blue-100 to-blue-50 dark:from-blue-800/40 dark:to-blue-900/60"
            )}>
              {isGenerate ? (
                <Sparkles className="h-8 w-8 text-purple-500 dark:text-purple-400" />
              ) : (
                <Edit3 className="h-8 w-8 text-blue-500 dark:text-blue-400" />
              )}
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
              {isStreaming ? 'Processing...' : 'No Results'}
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md">
              {error || status || 'Waiting for results...'}
            </p>
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <div className="h-10 px-4 py-2 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <Badge className={cn(
            "h-6 py-0.5",
            isGenerate
              ? "bg-gradient-to-b from-purple-50 to-purple-100 text-purple-700 border border-purple-200/50 dark:from-purple-900/30 dark:to-purple-800/20 dark:text-purple-400 dark:border-purple-800/30"
              : "bg-gradient-to-b from-blue-50 to-blue-100 text-blue-700 border border-blue-200/50 dark:from-blue-900/30 dark:to-blue-800/20 dark:text-blue-400 dark:border-blue-800/30"
          )}>
            {isGenerate ? <Sparkles className="h-3 w-3 mr-1" /> : <Edit3 className="h-3 w-3 mr-1" />}
            {isGenerate ? 'GENERATE' : 'EDIT'}
          </Badge>
          {!isStreaming && batchResults.length > 0 && (
            <Badge variant="outline" className="h-6 py-0.5">
              <ImageIcon className="h-3 w-3 mr-1" />
              {isBatch ? (
                <>
                  {successCount}/{batchResults.length} successful
                  {failedCount > 0 && (
                    <span className="text-rose-500 ml-1">• {failedCount} failed</span>
                  )}
                </>
              ) : (
                successCount > 0 ? '1 image' : 'failed'
              )}
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
