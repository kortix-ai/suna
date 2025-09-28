import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Presentation,
  Clock,
  Loader2,
  CheckCircle,
  AlertTriangle,
  FileText,
  Hash,
  Maximize2,
  Download,
  ExternalLink,
  ChevronDown,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, extractToolData, getToolTitle } from '../utils';
import { downloadPresentation, handleGoogleSlidesUpload } from '../utils/presentation-utils';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { CodeBlockCode } from '@/components/ui/code-block';
import { LoadingState } from '../shared/LoadingState';
import { FullScreenPresentationViewer } from './FullScreenPresentationViewer';
import { DownloadFormat } from '../utils/presentation-utils';

interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

interface PresentationMetadata {
  presentation_name: string;
  title: string;
  description: string;
  slides: Record<string, SlideMetadata>;
  created_at: string;
  updated_at: string;
}

interface PresentationViewerProps extends ToolViewProps {
  // All data will be extracted from toolContent
  showHeader?: boolean;
}

export function PresentationViewer({
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  name,
  project,
  showHeader = true,
}: PresentationViewerProps) {
  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);

  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [hasScrolledToCurrentSlide, setHasScrolledToCurrentSlide] = useState(false);
  const [backgroundRetryInterval, setBackgroundRetryInterval] = useState<NodeJS.Timeout | null>(null);

  const [visibleSlide, setVisibleSlide] = useState<number | null>(null);
  const [isFullScreenOpen, setIsFullScreenOpen] = useState(false);
  const [fullScreenInitialSlide, setFullScreenInitialSlide] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // Extract presentation info from tool data
  const { toolResult } = extractToolData(toolContent);
  let extractedPresentationName: string | undefined;
  let extractedPresentationPath: string | undefined;
  let currentSlideNumber: number | undefined;
  let presentationTitle: string | undefined;
  let toolExecutionError: string | undefined;

  if (toolResult && toolResult.toolOutput && toolResult.toolOutput !== 'STREAMING') {
    try {
      let output;
      
      if (typeof toolResult.toolOutput === 'string') {
        // Check if the string looks like an error message
        if (toolResult.toolOutput.startsWith('Error') || toolResult.toolOutput.includes('exec')) {
          console.error('Tool execution error:', toolResult.toolOutput);
          toolExecutionError = toolResult.toolOutput;
          // Don't return early - let the component render the error state
        } else {
          // Try to parse as JSON
          try {
            output = JSON.parse(toolResult.toolOutput);
          } catch (parseError) {
            console.error('Failed to parse tool output as JSON:', parseError);
            console.error('Raw tool output:', toolResult.toolOutput);
            toolExecutionError = `Failed to parse tool output: ${toolResult.toolOutput}`;
            // Don't return early - let the component render the error state
          }
        }
      } else {
        output = toolResult.toolOutput;
      }
      
      // Only extract data if we have a valid parsed object
      if (output && typeof output === 'object') {
        extractedPresentationName = output.presentation_name;
        extractedPresentationPath = output.presentation_path;
        currentSlideNumber = output.slide_number;
        presentationTitle = output.presentation_title || output.title;
      }
    } catch (e) {
      console.error('Failed to process tool output:', e);
      console.error('Tool output type:', typeof toolResult.toolOutput);
      console.error('Tool output value:', toolResult.toolOutput);
      toolExecutionError = `Unexpected error processing tool output: ${String(e)}`;
    }
  }

  // Get tool title for display
  const toolTitle = getToolTitle(name || 'presentation-viewer');

  // Helper function to sanitize filename (matching backend logic)
  const sanitizeFilename = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
  };

  // Load metadata.json for the presentation with retry logic
  const loadMetadata = async (retryCount = 0, maxRetries = 5) => {
    if (!extractedPresentationName || !project?.sandbox?.sandbox_url) return;
    
    setIsLoadingMetadata(true);
    setError(null);
    setRetryAttempt(retryCount);
    
    try {
      // Sanitize the presentation name to match backend directory creation
      const sanitizedPresentationName = sanitizeFilename(extractedPresentationName);
      
      const metadataUrl = constructHtmlPreviewUrl(
        project.sandbox.sandbox_url, 
        `presentations/${sanitizedPresentationName}/metadata.json`
      );
      
      // Add cache-busting parameter to ensure fresh data
      const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;
      
      console.log(`Loading presentation metadata (attempt ${retryCount + 1}/${maxRetries + 1}):`, urlWithCacheBust);
      
      const response = await fetch(urlWithCacheBust, {
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setMetadata(data);
        console.log('Successfully loaded presentation metadata:', data);
        setIsLoadingMetadata(false);
        
        // Clear background retry interval on success
        if (backgroundRetryInterval) {
          clearInterval(backgroundRetryInterval);
          setBackgroundRetryInterval(null);
        }
        
        return; // Success, exit early
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      console.error(`Error loading metadata (attempt ${retryCount + 1}):`, err);
      
      // If we haven't reached max retries, try again with exponential backoff
      if (retryCount < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Cap at 10 seconds
        console.log(`Retrying in ${delay}ms...`);
        
        setTimeout(() => {
          loadMetadata(retryCount + 1, maxRetries);
        }, delay);
        
        return; // Don't set error state yet, we're retrying
      }
      
      // All retries exhausted, set error and start background retry
      setError('Failed to load presentation metadata after multiple attempts');
      setIsLoadingMetadata(false);
      
      // Start background retry every 10 seconds
      if (!backgroundRetryInterval) {
        const interval = setInterval(() => {
          console.log('Background retry attempt...');
          loadMetadata(0, 2); // Fewer retries for background attempts
        }, 10000);
        setBackgroundRetryInterval(interval);
      }
    }
  };

  useEffect(() => {
    // Clear any existing background retry when dependencies change
    if (backgroundRetryInterval) {
      clearInterval(backgroundRetryInterval);
      setBackgroundRetryInterval(null);
    }
    loadMetadata();
  }, [extractedPresentationName, project?.sandbox?.sandbox_url, toolContent]);

  // Cleanup background retry interval on unmount
  useEffect(() => {
    return () => {
      if (backgroundRetryInterval) {
        clearInterval(backgroundRetryInterval);
      }
    };
  }, [backgroundRetryInterval]);

  // Reset scroll state when tool content changes (new tool call)
  useEffect(() => {
    setHasScrolledToCurrentSlide(false);
  }, [toolContent, currentSlideNumber]);

  // Scroll to current slide when metadata loads or when tool content changes
  useEffect(() => {
    if (metadata && currentSlideNumber && !hasScrolledToCurrentSlide) {
      // Wait longer for memoized components to render
      scrollToCurrentSlide(800);
      setHasScrolledToCurrentSlide(true);
    }
  }, [metadata, currentSlideNumber, hasScrolledToCurrentSlide]);

  const slides = metadata ? Object.entries(metadata.slides)
      .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
    .sort((a, b) => a.number - b.number) : [];

  // Additional effect to scroll when slides are actually rendered
  useEffect(() => {
    if (slides.length > 0 && currentSlideNumber && metadata && !hasScrolledToCurrentSlide) {
      // Extra delay to ensure DOM is fully rendered
      const timer = setTimeout(() => {
        scrollToCurrentSlide(100);
        setHasScrolledToCurrentSlide(true);
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [slides.length, currentSlideNumber, metadata, hasScrolledToCurrentSlide]);

  // Scroll-based slide detection with proper edge handling
  useEffect(() => {
    if (!slides.length) return;

    // Initialize with first slide
    setVisibleSlide(slides[0].number);

    const handleScroll = () => {
      
      const scrollArea = document.querySelector('[data-radix-scroll-area-viewport]');
      if (!scrollArea || slides.length === 0) return;

      const { scrollTop, scrollHeight, clientHeight } = scrollArea;
      const scrollViewportRect = scrollArea.getBoundingClientRect();
      const viewportCenter = scrollViewportRect.top + scrollViewportRect.height / 2;

      // Check if we're at the very top (first slide)
      if (scrollTop <= 10) {
        setVisibleSlide(slides[0].number);
        return;
      }

      // Check if we're at the very bottom (last slide)
      if (scrollTop + clientHeight >= scrollHeight - 10) {
        setVisibleSlide(slides[slides.length - 1].number);
        return;
      }

      // For middle slides, find the slide closest to the viewport center
      let closestSlide = slides[0];
      let smallestDistance = Infinity;

      slides.forEach((slide) => {
        const slideElement = document.getElementById(`slide-${slide.number}`);
        if (!slideElement) return;

        const slideRect = slideElement.getBoundingClientRect();
        const slideCenter = slideRect.top + slideRect.height / 2;
        const distanceFromCenter = Math.abs(slideCenter - viewportCenter);

        // Only consider slides that are at least partially visible
        const isPartiallyVisible = slideRect.bottom > scrollViewportRect.top && 
                                 slideRect.top < scrollViewportRect.bottom;

        if (isPartiallyVisible && distanceFromCenter < smallestDistance) {
          smallestDistance = distanceFromCenter;
          closestSlide = slide;
        }
      });

      setVisibleSlide(closestSlide.number);
    };

    // Debounce scroll handler for better performance
    let scrollTimeout: NodeJS.Timeout;
    const debouncedHandleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(handleScroll, 50);
    };

    const scrollArea = document.querySelector('[data-radix-scroll-area-viewport]');
    if (scrollArea) {
      scrollArea.addEventListener('scroll', debouncedHandleScroll);
      // Run once immediately to set initial state
      handleScroll();
    }

    return () => {
      clearTimeout(scrollTimeout);
      if (scrollArea) {
        scrollArea.removeEventListener('scroll', debouncedHandleScroll);
      }
    };
  }, [slides]);

  // Helper function to scroll to current slide
  const scrollToCurrentSlide = (delay: number = 200) => {
    if (!currentSlideNumber || !metadata) return;
    
    setTimeout(() => {
      const slideElement = document.getElementById(`slide-${currentSlideNumber}`);
      
      if (slideElement) {
        slideElement.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'center',
          inline: 'nearest'
        });
      } else {
        // Fallback: try again after a longer delay if element not found yet
        setTimeout(() => {
          const retryElement = document.getElementById(`slide-${currentSlideNumber}`);
          if (retryElement) {
            retryElement.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'center',
              inline: 'nearest'
            });
          }
        }, 500);
      }
    }, delay);
  };

  // Create a refresh timestamp when metadata changes
  const refreshTimestamp = useMemo(() => Date.now(), [metadata]);

  // Memoized slide iframe component to prevent unnecessary re-renders
  const SlideIframe = useMemo(() => {
    const SlideIframeComponent = React.memo(({ slide }: { slide: SlideMetadata & { number: number } }) => {
      const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
      const [scale, setScale] = useState(1);

      useEffect(() => {
        if (containerRef) {
          const updateScale = () => {
            const containerWidth = containerRef.offsetWidth;
            const containerHeight = containerRef.offsetHeight;
            
            // Calculate scale to fit 1920x1080 into container while maintaining aspect ratio
            const scaleX = containerWidth / 1920;
            const scaleY = containerHeight / 1080;
            const newScale = Math.min(scaleX, scaleY);
            
            // Only update if scale actually changed to prevent unnecessary re-renders
            if (Math.abs(newScale - scale) > 0.001) {
              setScale(newScale);
            }
          };

          // Use a debounced version for resize events to prevent excessive updates
          let resizeTimeout: NodeJS.Timeout;
          const debouncedUpdateScale = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(updateScale, 100);
          };

          updateScale();
          window.addEventListener('resize', debouncedUpdateScale);
          return () => {
            window.removeEventListener('resize', debouncedUpdateScale);
            clearTimeout(resizeTimeout);
          };
        }
      }, [containerRef, scale]);

      if (!project?.sandbox?.sandbox_url) {
        return (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Presentation className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No slide content to preview</p>
            </div>
          </div>
        );
      }

      const slideUrl = constructHtmlPreviewUrl(project.sandbox.sandbox_url, slide.file_path);
      // Add cache-busting to iframe src to ensure fresh content
      const slideUrlWithCacheBust = `${slideUrl}?t=${refreshTimestamp}`;

      return (
        <div className="w-full h-full flex items-center justify-center bg-transparent">
          <div 
            ref={setContainerRef}
            className="relative w-full h-full bg-background rounded-lg overflow-hidden"
            style={{
              containIntrinsicSize: '1920px 1080px',
              contain: 'layout style'
            }}
          >
            <iframe
              key={`slide-${slide.number}-${refreshTimestamp}`} // Key with stable timestamp ensures iframe refreshes when metadata changes
              src={slideUrlWithCacheBust}
              title={`Slide ${slide.number}: ${slide.title}`}
              className="border-0 rounded-xl"
              sandbox="allow-same-origin allow-scripts"
              style={{
                width: '1920px',
                height: '1080px',
                border: 'none',
                display: 'block',
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
                position: 'absolute',
                top: 0,
                left: 0,
                willChange: 'transform',
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden'
              }}
            />
          </div>
        </div>
      );
    }, (prevProps, nextProps) => {
      // Custom comparison function - only re-render if slide number or file_path changes
      return prevProps.slide.number === nextProps.slide.number && 
             prevProps.slide.file_path === nextProps.slide.file_path;
    });
    
    SlideIframeComponent.displayName = 'SlideIframeComponent';
    return SlideIframeComponent;
  }, [project?.sandbox?.sandbox_url, refreshTimestamp]);

  // Render individual slide using the original approach
  const renderSlidePreview = useCallback((slide: SlideMetadata & { number: number }) => {
    return <SlideIframe slide={slide} />;
  }, [SlideIframe]);

  const handleDownload = async (setIsDownloading: (isDownloading: boolean) => void, format: DownloadFormat) => {
    
    if (!project?.sandbox?.sandbox_url || !extractedPresentationName) return;

    setIsDownloading(true);
    try{
      if (format === DownloadFormat.GOOGLE_SLIDES){
        const result = await handleGoogleSlidesUpload(project!.sandbox!.sandbox_url, `/workspace/presentations/${extractedPresentationName}`);
        // If redirected to auth, don't show error
        if (result?.redirected_to_auth) {
          return; // Don't set loading false, user is being redirected
        }
      } else{
        await downloadPresentation(format, project.sandbox.sandbox_url, `/workspace/presentations/${extractedPresentationName}`, extractedPresentationName);
      }
    } catch (error) {
      console.error('Error downloading PDF:', error);
    } finally {
      setIsDownloading(false);
    }
  };
  

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      {showHeader && <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <Presentation className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {metadata?.title || metadata?.presentation_name || toolTitle}
              </CardTitle>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Export actions */}
            {metadata && slides.length > 0 && !isStreaming && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFullScreenInitialSlide(visibleSlide || currentSlideNumber || slides[0]?.number || 1);
                    setIsFullScreenOpen(true);
                  }}
                  className="h-8 w-8 p-0"
                  title="Open in full screen"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 w-8 p-0"
                      title="Export presentation"
                      disabled={isDownloading}
                    >
                      {isDownloading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-32">
                    <DropdownMenuItem 
                      onClick={() => handleDownload(setIsDownloading, DownloadFormat.PDF)}
                      className="cursor-pointer"
                      disabled={isDownloading}
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => handleDownload(setIsDownloading, DownloadFormat.PPTX)}
                      className="cursor-pointer"
                      disabled={isDownloading}
                    >
                      <Presentation className="h-4 w-4 mr-2" />
                      PPTX
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => handleDownload(setIsDownloading, DownloadFormat.GOOGLE_SLIDES)}
                      className="cursor-pointer"
                      disabled={isDownloading}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Google Slides
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}

            {!isStreaming && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Success
              </Badge>
            )}

            {isStreaming && (
              <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Loading
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>}



      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {(isStreaming || (isLoadingMetadata && !metadata)) ? (
          <LoadingState
            icon={Presentation}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Loading presentation"
            filePath={retryAttempt > 0 ? `Retrying... (attempt ${retryAttempt + 1})` : "Loading slides..."}
            showProgress={true}
          />
        ) : error || toolExecutionError || !metadata ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {toolExecutionError ? 'Tool Execution Error' : (error || 'Failed to load presentation')}
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md mb-4">
              {toolExecutionError ? 'The presentation tool encountered an error during execution:' : 
               (error || 'There was an error loading the presentation. Please try again.')}
            </p>
            {retryAttempt > 0 && !toolExecutionError && (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">
                Attempted {retryAttempt + 1} times
              </p>
            )}
            {backgroundRetryInterval && !toolExecutionError && (
              <p className="text-xs text-blue-500 dark:text-blue-400 mb-4 flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Retrying in background...
              </p>
            )}
            {!toolExecutionError && error && (
              <Button 
                onClick={() => loadMetadata()} 
                variant="outline" 
                size="sm"
                disabled={isLoadingMetadata}
                className="mb-4"
              >
                {isLoadingMetadata ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Retrying...
                  </>
                ) : (
                  'Try Again'
                )}
              </Button>
            )}
            {toolExecutionError && (
              <div className="w-full max-w-2xl">
                <CodeBlockCode 
                  code={toolExecutionError} 
                  language="text"
                  className="text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded-md border"
                />
              </div>
            )}
          </div>
        ) : slides.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60">
              <Presentation className="h-10 w-10 text-blue-400 dark:text-blue-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No slides found
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              This presentation doesn't have any slides yet.
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="space-y-4 p-4">
              {slides.map((slide) => (
                <div 
                  key={slide.number} 
                  id={`slide-${slide.number}`} 
                  className={`group relative bg-background border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden hover:shadow-lg hover:shadow-black/5 dark:hover:shadow-black/20 hover:scale-[1.01] transition-all duration-200 ${currentSlideNumber === slide.number && 'ring-2 ring-blue-500/20 shadow-md'}`}
                >
                  {/* Slide header */}
                  <div className="px-3 py-2 bg-muted/20 border-b border-border/40 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="h-6 px-2 text-xs font-mono">
                        #{slide.number}
                      </Badge>
                      {slide.title && (
                        <span className="text-sm text-muted-foreground truncate">
                          {slide.title}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setFullScreenInitialSlide(slide.number);
                        setIsFullScreenOpen(true);
                      }}
                      className="h-8 w-8 p-0 opacity-60 group-hover:opacity-100 transition-opacity"
                      title="Open in full screen"
                    >
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                  </div>
                  
                  {/* Slide Preview */}
                  <div 
                    className="relative aspect-video bg-muted/30 cursor-pointer"
                    onClick={() => {
                      setFullScreenInitialSlide(slide.number);
                      setIsFullScreenOpen(true);
                    }}
                  >
                    {renderSlidePreview(slide)}
                    
                    {/* Subtle hover overlay */}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors duration-200" />
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <div className="px-4 py-2 h-9 bg-muted/20 border-t border-border/40 flex justify-between items-center">
        <div className="text-xs text-muted-foreground">
          {slides.length > 0 && visibleSlide && (
            <span className="font-mono">
              {visibleSlide}/{slides.length}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatTimestamp(toolTimestamp)}
        </div>
      </div>

      {/* Full Screen Presentation Viewer */}
      <FullScreenPresentationViewer
        isOpen={isFullScreenOpen}
        onClose={() => {
          setIsFullScreenOpen(false);
          setFullScreenInitialSlide(null);
          // Reload metadata after closing full screen viewer in case edits were made
          setTimeout(() => {
            loadMetadata();
          }, 300);
        }}
        presentationName={extractedPresentationName}
        sandboxUrl={project?.sandbox?.sandbox_url}
        initialSlide={fullScreenInitialSlide || visibleSlide || currentSlideNumber || slides[0]?.number || 1}
      />
    </Card>
  );
}
