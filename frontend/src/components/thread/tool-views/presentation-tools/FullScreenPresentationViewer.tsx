import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Presentation,
  SkipBack,
  SkipForward,
  Edit,
  Loader2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { downloadPresentation, DownloadFormat, handleGoogleSlidesUpload } from '../utils/presentation-utils';
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

interface FullScreenPresentationViewerProps {
  isOpen: boolean;
  onClose: () => void;
  presentationName?: string;
  sandboxUrl?: string;
  initialSlide?: number;
}

export function FullScreenPresentationViewer({
  isOpen,
  onClose,
  presentationName,
  sandboxUrl,
  initialSlide = 1,
}: FullScreenPresentationViewerProps) {
  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);
  const [currentSlide, setCurrentSlide] = useState(initialSlide);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRef = useRef(false);
  const [showControls, setShowControls] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  const [isDownloadingPPTX, setIsDownloadingPPTX] = useState(false);
  const [isDownloadingGoogleSlides, setIsDownloadingGoogleSlides] = useState(false);
  
  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'presentations',
  });
  
  // Create a stable refresh timestamp when metadata changes (like PresentationViewer)
  const refreshTimestamp = useMemo(() => metadata?.updated_at || Date.now(), [metadata?.updated_at]);

  const slides = metadata ? Object.entries(metadata.slides)
    .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
    .sort((a, b) => a.number - b.number) : [];

  const totalSlides = slides.length;

  // Helper function to sanitize filename (matching backend logic)
  const sanitizeFilename = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
  };

  // Load metadata with retry logic
  const loadMetadata = useCallback(async (retryCount = 0, maxRetries = Infinity) => {
    // Don't load if we already successfully loaded metadata
    if (hasLoadedRef.current) {
      return;
    }
    
    // If sandbox URL isn't available yet, wait and don't set loading state
    if (!presentationName || !sandboxUrl) {
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    setRetryAttempt(retryCount);
    
    try {
      // Sanitize the presentation name to match backend directory creation
      const sanitizedPresentationName = sanitizeFilename(presentationName);
      
      const metadataUrl = constructHtmlPreviewUrl(
        sandboxUrl, 
        `presentations/${sanitizedPresentationName}/metadata.json`
      );
      
      const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;
      console.log(`Loading presentation metadata (attempt ${retryCount + 1}):`, urlWithCacheBust);
      
      const response = await fetch(urlWithCacheBust, {
        cache: 'no-cache',
        headers: { 'Cache-Control': 'no-cache' }
      });
      
      if (response.ok) {
        const data = await response.json();
        setMetadata(data);
        hasLoadedRef.current = true; // Mark as successfully loaded
        console.log('Successfully loaded presentation metadata:', data);
        setIsLoading(false);
        
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
      
      // Calculate delay with exponential backoff, capped at 10 seconds
      // For early attempts, use shorter delays. After 5 attempts, use consistent 5 second intervals
      const delay = retryCount < 5 
        ? Math.min(1000 * Math.pow(2, retryCount), 10000) // Exponential backoff for first 5 attempts
        : 5000; // Consistent 5 second intervals after that
      
      console.log(`Retrying in ${delay}ms... (attempt ${retryCount + 1})`);
      
      // Keep retrying indefinitely - don't set error state
      retryTimeoutRef.current = setTimeout(() => {
        loadMetadata(retryCount + 1, maxRetries);
      }, delay);
      
      return; // Keep loading state, don't set error
    }
  }, [presentationName, sandboxUrl]);

  useEffect(() => {
    if (isOpen) {
      // Reset loaded flag when opening (so we can reload if needed)
      hasLoadedRef.current = false;
      
      // Clear any existing retry timeout when opening
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      
      // Only start loading if we have the required data
      if (presentationName && sandboxUrl) {
        loadMetadata();
      } else {
        setIsLoading(false);
      }
      setCurrentSlide(initialSlide);
    } else {
      // Clear retry timeout when closing
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    }
  }, [isOpen, presentationName, sandboxUrl, initialSlide]);

  // Cleanup retry timeout on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  // Reload metadata when exiting editor mode to refresh with latest changes
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    
    if (!showEditor && isOpen) {
      // Reset loaded flag so we can reload after editor changes
      hasLoadedRef.current = false;
      
      // Add a small delay to allow the editor to save changes
      timeoutId = setTimeout(() => {
        loadMetadata();
      }, 300);
    }
    
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEditor, isOpen]);

  // Navigation functions
  const goToNextSlide = useCallback(() => {
    if (currentSlide < totalSlides) {
      setCurrentSlide(prev => prev + 1);
    }
  }, [currentSlide, totalSlides]);

  const goToPreviousSlide = useCallback(() => {
    if (currentSlide > 1) {
      setCurrentSlide(prev => prev - 1);
    }
  }, [currentSlide]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      
      // Prevent default for all our handled keys
      const handledKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End', 'Escape'];
      if (handledKeys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          goToPreviousSlide();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
          goToNextSlide();
          break;
        case 'Home':
          setCurrentSlide(1);
          break;
        case 'End':
          setCurrentSlide(totalSlides);
          break;
        case 'Escape':
          if (showEditor) {
            setShowEditor(false);
          } else {
            onClose();
          }
          break;
      }
    };

    // Add event listener to document with capture to ensure we get the events first
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, goToNextSlide, goToPreviousSlide, totalSlides, onClose, showEditor]);



  // Always show controls
  useEffect(() => {
    if (isOpen) {
      setShowControls(true);
    }
  }, [isOpen]);

  // Download handlers
  const handleDownload = async (format: DownloadFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!sandboxUrl || !presentationName) return;

    const setDownloadState = format === DownloadFormat.PDF ? setIsDownloadingPDF : 
                           format === DownloadFormat.PPTX ? setIsDownloadingPPTX : 
                           setIsDownloadingGoogleSlides;

    setDownloadState(true);
    try {
      if (format === DownloadFormat.GOOGLE_SLIDES) {
        const result = await handleGoogleSlidesUpload(sandboxUrl, `/workspace/presentations/${presentationName}`);
        // If redirected to auth, don't show error
        if (result?.redirected_to_auth) {
          return; // Don't set loading false, user is being redirected
        }
      } else {
        await downloadPresentation(format, sandboxUrl, `/workspace/presentations/${presentationName}`, presentationName);
      }
    } catch (error) {
      console.error(`Error downloading ${format}:`, error);
    } finally {
      setDownloadState(false);
    }
  };

  const currentSlideData = slides.find(slide => slide.number === currentSlide);

  // Memoized slide iframe component with proper scaling (matching PresentationViewer)
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

      if (!sandboxUrl) {
        return (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Presentation className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No slide content to preview</p>
            </div>
          </div>
        );
      }

      const slideUrl = constructHtmlPreviewUrl(sandboxUrl, slide.file_path);
      // Add cache-busting to iframe src to ensure fresh content
      const slideUrlWithCacheBust = `${slideUrl}?t=${refreshTimestamp}`;

      return (
        <div className="w-full h-full flex items-center justify-center bg-transparent">
          <div 
            ref={setContainerRef}
            className="relative bg-transparent rounded-lg overflow-hidden"
            style={{
              width: '100%',
              maxWidth: '100%',
              aspectRatio: '16 / 9',
              maxHeight: '100%',
              containIntrinsicSize: '1920px 1080px',
              contain: 'layout style'
            }}
          >
            <iframe
              key={`slide-${slide.number}-${refreshTimestamp}-${showEditor}`} // Key with stable timestamp ensures iframe refreshes when metadata changes
              src={showEditor ? `${sandboxUrl}/api/html/${slide.file_path}/editor` : slideUrlWithCacheBust}
              title={`Slide ${slide.number}: ${slide.title}`}
              className="border-0 rounded-xl"
              sandbox="allow-same-origin allow-scripts allow-modals"
              style={{
                width: '1920px',
                height: '1080px',
                border: 'none',
                display: 'block',
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
                position: 'absolute',
                top: 0,
                left: `calc((100% - ${1920 * scale}px) / 2)`,
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
  }, [sandboxUrl, refreshTimestamp, showEditor]);

  // Render slide iframe with proper scaling
  const renderSlide = useMemo(() => {
    if (!currentSlideData || !sandboxUrl) return null;

    return <SlideIframe slide={currentSlideData} />;
  }, [currentSlideData, sandboxUrl, SlideIframe]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col">
      {/* Top Controls Bar */}
      <div className="flex-shrink-0 bg-white dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700">
              <Presentation className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
            </div>
            
            {metadata && (
              <div>
                <h1 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                  {metadata.title || metadata.presentation_name}
                </h1>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Slide {currentSlide} of {totalSlides}
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Edit button */}
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 w-8 p-0"
              title={showEditor ? "Close editor" : "Edit presentation"}
              onClick={() => setShowEditor(!showEditor)}
            >
              {showEditor ? <Presentation className="h-3.5 w-3.5" /> : <Edit className='h-3.5 w-3.5'/>}
            </Button>

            {/* Export dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-8 w-8 p-0"
                  title="Export presentation"
                  disabled={isDownloadingPDF || isDownloadingPPTX || isDownloadingGoogleSlides}
                >
                  {(isDownloadingPDF || isDownloadingPPTX || isDownloadingGoogleSlides) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                <DropdownMenuItem 
                  className="cursor-pointer" 
                  onClick={() => handleDownload(DownloadFormat.PDF)} 
                  disabled={isDownloadingPDF}
                >
                  <FileText className="h-4 w-4 mr-2" />
                  PDF
                </DropdownMenuItem>
                <DropdownMenuItem 
                  className="cursor-pointer" 
                  onClick={() => handleDownload(DownloadFormat.PPTX)} 
                  disabled={isDownloadingPPTX}
                >
                  <Presentation className="h-4 w-4 mr-2" />
                  PPTX
                </DropdownMenuItem>
                <DropdownMenuItem 
                  className="cursor-pointer" 
                  onClick={() => handleDownload(DownloadFormat.GOOGLE_SLIDES)} 
                  disabled={isDownloadingGoogleSlides}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Google Slides
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Close button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0"
              title="Close full screen"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex items-center justify-center bg-zinc-100 dark:bg-zinc-900 p-2 min-h-0">
        {isLoading || !currentSlideData ? (
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-600 mx-auto mb-4"></div>
            <p className="text-zinc-700 dark:text-zinc-300">
              {retryAttempt > 0 ? `Retrying... (attempt ${retryAttempt + 1})` : 'Loading presentation...'}
            </p>
          </div>
        ) : currentSlideData ? (
          <div className="w-full h-full flex flex-col">
            {/* Presentation Container */}
            <div className="flex-1 bg-transparent rounded-xl overflow-hidden" style={{ aspectRatio: '16 / 9' }}>
              {renderSlide}
            </div>
            
            {/* Controls below presentation */}
            <div className="flex items-center justify-between mt-3 px-4">
              {/* Left Controls */}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentSlide(1)}
                  disabled={currentSlide <= 1}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <SkipBack className="h-3.5 w-3.5" />
                </Button>
                
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goToPreviousSlide}
                  disabled={currentSlide <= 1}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </div>

              {/* Center - Slide Indicators */}
              <div className="flex items-center">
                <div className="flex gap-2">
                  {slides.map((slide) => (
                    <button
                      key={slide.number}
                      onClick={() => setCurrentSlide(slide.number)}
                      className={`w-2.5 h-2.5 rounded-full transition-all duration-200 ${
                        slide.number === currentSlide
                          ? 'bg-black dark:bg-white'
                          : 'bg-zinc-300 dark:bg-zinc-600 hover:bg-zinc-400 dark:hover:bg-zinc-500'
                      }`}
                    />
                  ))}
                </div>
              </div>

              {/* Right Controls */}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goToNextSlide}
                  disabled={currentSlide >= totalSlides}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentSlide(totalSlides)}
                  disabled={currentSlide >= totalSlides}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-zinc-700 dark:text-zinc-300">No slide found</p>
          </div>
        )}
      </div>
    </div>
  );
}
