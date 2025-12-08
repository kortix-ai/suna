import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { formatTimestamp, getToolTitle } from '../utils';
import { downloadPresentation, handleGoogleSlidesUpload } from '../utils/presentation-utils';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { CodeBlockCode } from '@/components/ui/code-block';
import { LoadingState } from '../shared/LoadingState';
import { FullScreenPresentationViewer } from './FullScreenPresentationViewer';
import { DownloadFormat } from '../utils/presentation-utils';
import { PresentationSlideCard } from './PresentationSlideCard';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';
import { backendApi } from '@/lib/api-client';
import { useDownloadRestriction } from '@/hooks/billing';

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
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  showHeader = true,
}: PresentationViewerProps) {
  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);

  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [hasScrolledToCurrentSlide, setHasScrolledToCurrentSlide] = useState(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRef = useRef(false);
  const sandboxCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isEnsuringSandboxRef = useRef(false);
  
  // Cache metadata by presentation name to avoid re-loading when switching between tool calls
  const metadataCacheRef = useRef<Map<string, PresentationMetadata>>(new Map());
  const lastPresentationNameRef = useRef<string | null>(null);

  const [visibleSlide, setVisibleSlide] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  
  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'presentations',
  });
  
  // Use shared modal store for full screen viewer
  const { isOpen, presentationName, sandboxUrl, initialSlide, openPresentation, closePresentation } = usePresentationViewerStore();
  const viewerState = { isOpen, presentationName, sandboxUrl, initialSlide };

  // Helper function to sanitize filename (matching backend logic)
  const sanitizeFilename = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
  };

  // Extract presentation info from toolResult.output (from metadata)
  let extractedPresentationName: string | undefined;
  let extractedPresentationPath: string | undefined;
  let currentSlideNumber: number | undefined;
  let presentationTitle: string | undefined;
  let toolExecutionError: string | undefined;

  if (toolResult?.output) {
    try {
      let output = toolResult.output;
      
      // Handle string output
      if (typeof output === 'string') {
        // Check if the string looks like an error message
        if (output.startsWith('Error') || output.includes('exec')) {
          console.error('Tool execution error:', output);
          toolExecutionError = output;
        } else {
          // Try to parse as JSON
          try {
            output = JSON.parse(output);
          } catch (parseError) {
            console.error('Failed to parse tool output as JSON:', parseError);
            console.error('Raw tool output:', output);
            toolExecutionError = `Failed to parse tool output: ${output}`;
          }
        }
      }
      
      // Only extract data if we have a valid parsed object
      if (output && typeof output === 'object' && !toolExecutionError) {
        extractedPresentationName = output.presentation_name;
        extractedPresentationPath = output.presentation_path;
        currentSlideNumber = output.slide_number;
        presentationTitle = output.presentation_title || output.title;
      }
    } catch (e) {
      console.error('Failed to process tool output:', e);
      console.error('Tool output type:', typeof toolResult.output);
      console.error('Tool output value:', toolResult.output);
      toolExecutionError = `Unexpected error processing tool output: ${String(e)}`;
    }
  }

  // Get tool title for display
  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'presentation-viewer';
  const toolTitle = getToolTitle(name);

  // Ensure sandbox is active and wait for sandbox URL
  const ensureSandboxActive = useCallback(async () => {
    if (!project?.id || !project?.sandbox?.id || isEnsuringSandboxRef.current) {
      return;
    }

    isEnsuringSandboxRef.current = true;
    
    try {
      const response = await backendApi.post(
        `/project/${project.id}/sandbox/ensure-active`,
        {},
        { showErrors: false }
      );

      if (response.error) {
        console.warn('Failed to ensure sandbox is active:', response.error);
        isEnsuringSandboxRef.current = false;
        return;
      }
      
      // Dispatch event for other components
      window.dispatchEvent(new CustomEvent('sandbox-active', {
        detail: { sandboxId: project.sandbox.id, projectId: project.id }
      }));
      
      isEnsuringSandboxRef.current = false;
    } catch (err) {
      console.error('Error ensuring sandbox is active:', err);
      isEnsuringSandboxRef.current = false;
    }
  }, [project?.id, project?.sandbox?.id]);

  // Load metadata.json for the presentation with retry logic
  const loadMetadata = useCallback(async (retryCount = 0, maxRetries = Infinity, forceRefresh = false) => {
    if (!extractedPresentationName) {
      setIsLoadingMetadata(false);
      return;
    }

    const sanitizedPresentationName = sanitizeFilename(extractedPresentationName);
    
    // Check if we have cached metadata for this presentation FIRST
    const cachedMetadata = metadataCacheRef.current.get(sanitizedPresentationName);
    
    // If we have cached data and this is not a force refresh, use it immediately
    if (cachedMetadata && !forceRefresh) {
      setMetadata(cachedMetadata);
      setIsLoadingMetadata(false);
      hasLoadedRef.current = true;
      // Still refresh in background to get latest data if we have sandbox URL
      if (project?.sandbox?.sandbox_url) {
        loadMetadata(0, maxRetries, true);
      }
      return;
    }
    
    // If sandbox URL isn't available yet, wait and don't set loading state
    // But if we have cached data, we already returned above
    if (!project?.sandbox?.sandbox_url) {
      setIsLoadingMetadata(false);
      return;
    }
    
    // Only show loading if we don't have any cached data
    if (!cachedMetadata) {
      setIsLoadingMetadata(true);
    }
    setError(null);
    setRetryAttempt(retryCount);
    
    try {
      const metadataUrl = constructHtmlPreviewUrl(
        project.sandbox.sandbox_url, 
        `presentations/${sanitizedPresentationName}/metadata.json`
      );
      
      // Add cache-busting parameter to ensure fresh data
      const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;
      
      const response = await fetch(urlWithCacheBust, {
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        
        console.log('[PresentationViewer] Metadata loaded successfully:', {
          presentationName: sanitizedPresentationName,
          slideCount: Object.keys(data.slides || {}).length,
          metadata: data
        });
        
        // Cache the metadata
        metadataCacheRef.current.set(sanitizedPresentationName, data);
        
        setMetadata(data);
        hasLoadedRef.current = true;
        setIsLoadingMetadata(false);
        
        // Clear any pending retry timeout on success
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
        
        return; // Success, exit early
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      console.error(`Error loading metadata (attempt ${retryCount + 1}):`, err);
      
      // If we get HTTP 400 or 502, the sandbox might be stopped - try to wake it up
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('400') || errorMessage.includes('502') || errorMessage.includes('503')) {
        // Reset the ensuring flag so ensureSandboxActive can run again
        isEnsuringSandboxRef.current = false;
        // Trigger sandbox wake-up
        ensureSandboxActive();
      }
      
      // If we have cached data, don't show loading state during retries
      if (cachedMetadata) {
        setIsLoadingMetadata(false);
      }
      
      // Calculate delay with exponential backoff, capped at 10 seconds
      const delay = retryCount < 5 
        ? Math.min(1000 * Math.pow(2, retryCount), 10000)
        : 5000;
      
      // Keep retrying indefinitely - don't set error state
      retryTimeoutRef.current = setTimeout(() => {
        loadMetadata(retryCount + 1, maxRetries, forceRefresh);
      }, delay);
      
      return;
    }
  }, [extractedPresentationName, project?.sandbox?.sandbox_url, ensureSandboxActive]);

  // Poll for sandbox URL availability and listen for sandbox-active events
  useEffect(() => {
    // If we have sandbox URL, no need to poll
    if (project?.sandbox?.sandbox_url) {
      if (sandboxCheckIntervalRef.current) {
        clearInterval(sandboxCheckIntervalRef.current);
        sandboxCheckIntervalRef.current = null;
      }
      return;
    }

    // If we have sandbox ID but no URL, ensure sandbox is active
    if (project?.sandbox?.id && !project?.sandbox?.sandbox_url && extractedPresentationName) {
      // Ensure sandbox is active first
      ensureSandboxActive();
    }

    // Listen for sandbox-active event
    const handleSandboxActive = (event: CustomEvent) => {
      if (event.detail?.projectId === project?.id) {
        // The project prop should update with sandbox_url, which will trigger
        // the useEffect that watches project?.sandbox?.sandbox_url
        // Clear the ensuring flag so ensureSandboxActive can run again if needed
        isEnsuringSandboxRef.current = false;
      }
    };

    window.addEventListener('sandbox-active', handleSandboxActive as EventListener);

    return () => {
      window.removeEventListener('sandbox-active', handleSandboxActive as EventListener);
      if (sandboxCheckIntervalRef.current) {
        clearInterval(sandboxCheckIntervalRef.current);
        sandboxCheckIntervalRef.current = null;
      }
    };
  }, [project?.id, project?.sandbox?.id, project?.sandbox?.sandbox_url, extractedPresentationName, ensureSandboxActive]);

  useEffect(() => {
    // Check if presentation changed
    const sanitizedName = extractedPresentationName ? sanitizeFilename(extractedPresentationName) : null;
    const presentationChanged = sanitizedName !== lastPresentationNameRef.current;
    
    // Only reset loaded flag if presentation actually changed
    if (presentationChanged) {
      hasLoadedRef.current = false;
      lastPresentationNameRef.current = sanitizedName;
    }
    
    // Clear any existing retry timeout when dependencies change
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    
    // FIRST: Check for cached metadata and use it immediately if available
    if (sanitizedName) {
      const cachedMetadata = metadataCacheRef.current.get(sanitizedName);
      if (cachedMetadata && !metadata) {
        // Set cached metadata immediately so slides can render right away
        console.log('[PresentationViewer] Using cached metadata immediately:', {
          presentationName: sanitizedName,
          slideCount: Object.keys(cachedMetadata.slides || {}).length,
          cachedMetadata
        });
        setMetadata(cachedMetadata);
        setIsLoadingMetadata(false);
        hasLoadedRef.current = true;
      }
    }
    
    // THEN: Start loading fresh data if we have the required data
    if (extractedPresentationName && project?.sandbox?.sandbox_url) {
      console.log('[PresentationViewer] Starting metadata load:', {
        presentationName: sanitizedName,
        sandboxUrl: project.sandbox.sandbox_url,
        hasCachedMetadata: !!metadataCacheRef.current.get(sanitizedName || ''),
        currentMetadata: !!metadata
      });
      loadMetadata();
    } else if (extractedPresentationName && project?.sandbox?.id && !project?.sandbox?.sandbox_url) {
      // Sandbox exists but URL not available yet
      // Only show loading if we don't have cached data for this presentation
      const hasCachedData = sanitizedName && metadataCacheRef.current.has(sanitizedName);
      if (!hasCachedData && !metadata) {
        setIsLoadingMetadata(true);
      } else {
        setIsLoadingMetadata(false);
      }
    } else {
      setIsLoadingMetadata(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractedPresentationName, project?.sandbox?.sandbox_url, toolResult?.output]);

  // Cleanup retry timeout and sandbox check interval on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      if (sandboxCheckIntervalRef.current) {
        clearInterval(sandboxCheckIntervalRef.current);
      }
    };
  }, []);

  // Create a unique key for this tool call to track scroll state
  const toolCallKey = useMemo(() => {
    return `${toolCall?.tool_call_id || ''}-${currentSlideNumber || ''}-${extractedPresentationName || ''}`;
  }, [toolCall?.tool_call_id, currentSlideNumber, extractedPresentationName]);

  // Reset scroll state when tool call changes (new tool call opened)
  useEffect(() => {
    setHasScrolledToCurrentSlide(false);
  }, [toolCallKey]);

  const slides = metadata ? Object.entries(metadata.slides)
      .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
    .sort((a, b) => a.number - b.number) : [];

  // Scroll to current slide when metadata loads or when tool content changes
  useEffect(() => {
    if (metadata && currentSlideNumber && !hasScrolledToCurrentSlide && slides.length > 0) {
      // Wait for DOM to be ready, then scroll
      const timer = setTimeout(() => {
        scrollToCurrentSlide(100);
        setHasScrolledToCurrentSlide(true);
      }, 300);

      return () => clearTimeout(timer);
    }
  }, [metadata, currentSlideNumber, hasScrolledToCurrentSlide, slides.length]);

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


  const handleDownload = async (setIsDownloading: (isDownloading: boolean) => void, format: DownloadFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    
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
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      {showHeader && <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700">
              <Presentation className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
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
                    if (openPresentation && project?.sandbox?.sandbox_url && extractedPresentationName) {
                      openPresentation(
                        extractedPresentationName,
                        project.sandbox.sandbox_url,
                        visibleSlide || currentSlideNumber || slides[0]?.number || 1
                      );
                    }
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
        {(isStreaming || (isLoadingMetadata && !metadata) || (!metadata && !toolExecutionError && extractedPresentationName)) ? (
          <LoadingState
            icon={Presentation}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Loading presentation"
            filePath={retryAttempt > 0 ? `Retrying... (attempt ${retryAttempt + 1})` : "Loading slides..."}
            showProgress={true}
          />
        ) : toolExecutionError ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Tool Execution Error
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md mb-4">
              The presentation tool encountered an error during execution:
            </p>
            <div className="w-full max-w-2xl">
              <CodeBlockCode 
                code={toolExecutionError} 
                language="text"
                className="text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded-md border"
              />
            </div>
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
                <div key={slide.number} id={`slide-${slide.number}`}>
                  <PresentationSlideCard
                    slide={slide}
                    project={project}
                    onFullScreenClick={(slideNumber) => {
                      if (openPresentation && project?.sandbox?.sandbox_url && extractedPresentationName) {
                        openPresentation(extractedPresentationName, project.sandbox.sandbox_url, slideNumber);
                      }
                    }}
                    className={currentSlideNumber === slide.number ? 'ring-2 ring-blue-500/20 shadow-md' : ''}
                    refreshTimestamp={metadata?.updated_at ? new Date(metadata.updated_at).getTime() : undefined}
                  />
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

      {/* Full Screen Presentation Viewer Modal */}
      <FullScreenPresentationViewer
        isOpen={viewerState.isOpen}
        onClose={closePresentation}
        presentationName={viewerState.presentationName}
        sandboxUrl={viewerState.sandboxUrl}
        initialSlide={viewerState.initialSlide}
      />
    </Card>
  );
}
