import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useDownloadRestriction } from '@/hooks/billing';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { PRESENTATION_WITH_MODALS_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { fetchPresentationMetadata, sanitizePresentationName } from '@kortix/sdk';
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  DownloadIcon as Download,
  PencilSimpleIcon as Edit,
  ArrowSquareOutIcon as ExternalLink,
  FileTextIcon as FileText,
  PresentationIcon as Presentation,
  SkipBackIcon as SkipBack,
  SkipForwardIcon as SkipForward,
  XIcon as X,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DownloadFormat,
  downloadPresentation,
  handleGoogleSlidesUpload,
} from './presentation-utils';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { subdomainOpts } = useSandboxProxy();
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

  // Track the previous isOpen state to detect when modal opens
  const wasOpenRef = useRef(false);

  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'presentations',
  });

  // Create a stable refresh timestamp when metadata changes (like PresentationViewer)
  const refreshTimestamp = useMemo(
    () => metadata?.updated_at || Date.now(),
    [metadata?.updated_at],
  );

  const slides = metadata
    ? Object.entries(metadata.slides)
        .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
        .sort((a, b) => a.number - b.number)
    : [];

  const totalSlides = slides.length;

  // Load metadata with retry logic
  const loadMetadata = useCallback(
    async (retryCount = 0, maxRetries = Infinity) => {
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

      // The SDK owns the URL (name sanitizing + a cache-buster appended with
      // `&`, so it cannot land inside the static-file service's `path` value)
      // and treats "not written yet" as a status, not a throw. The retry
      // cadence stays here.
      const result = await fetchPresentationMetadata<PresentationMetadata>(
        presentationName,
        subdomainOpts,
      );

      if (result.status === 'ready') {
        setMetadata(result.metadata);
        hasLoadedRef.current = true; // Mark as successfully loaded
        setIsLoading(false);

        // Clear any pending retry timeout on success
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }

        return; // Success, exit early
      }

      console.warn(
        `Presentation metadata not ready (attempt ${retryCount + 1}):`,
        result.reason,
      );

      // Calculate delay with exponential backoff, capped at 10 seconds
      // For early attempts, use shorter delays. After 5 attempts, use consistent 5 second intervals
      const delay =
        retryCount < 5
          ? Math.min(1000 * Math.pow(2, retryCount), 10000) // Exponential backoff for first 5 attempts
          : 5000; // Consistent 5 second intervals after that

      // Keep retrying indefinitely - don't set error state
      retryTimeoutRef.current = setTimeout(() => {
        loadMetadata(retryCount + 1, maxRetries);
      }, delay);

      return; // Keep loading state, don't set error
    },
    [presentationName, sandboxUrl, subdomainOpts],
  );

  // Sync currentSlide with initialSlide when modal opens (not on every initialSlide change)
  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (justOpened) {
      // Modal just opened - set the slide to the requested initial slide
      setCurrentSlide(initialSlide);

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
    } else if (!isOpen) {
      // Clear retry timeout when closing
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    }
  }, [isOpen, presentationName, sandboxUrl, initialSlide, loadMetadata]);

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
      setCurrentSlide((prev) => prev + 1);
    }
  }, [currentSlide, totalSlides]);

  const goToPreviousSlide = useCallback(() => {
    if (currentSlide > 1) {
      setCurrentSlide((prev) => prev - 1);
    }
  }, [currentSlide]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent default for all our handled keys
      const handledKeys = [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        ' ',
        'Home',
        'End',
        'Escape',
      ];
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

    // Use sanitized name for the path (matching backend directory structure)
    const sanitizedName = sanitizePresentationName(presentationName);

    const setDownloadState =
      format === DownloadFormat.PDF
        ? setIsDownloadingPDF
        : format === DownloadFormat.PPTX
          ? setIsDownloadingPPTX
          : setIsDownloadingGoogleSlides;

    setDownloadState(true);
    try {
      if (format === DownloadFormat.GOOGLE_SLIDES) {
        const result = await handleGoogleSlidesUpload(
          sandboxUrl,
          `/workspace/presentations/${sanitizedName}`,
        );
        // If redirected to auth, don't show error
        if (result?.redirected_to_auth) {
          return; // Don't set loading false, user is being redirected
        }
      } else {
        await downloadPresentation(
          format,
          sandboxUrl,
          `/workspace/presentations/${sanitizedName}`,
          presentationName,
        );
      }
    } catch (error) {
      console.error(`Error downloading ${format}:`, error);
    } finally {
      setDownloadState(false);
    }
  };

  const currentSlideData = slides.find((slide) => slide.number === currentSlide);

  // Memoized slide iframe component with proper scaling (matching PresentationViewer)
  const SlideIframe = useMemo(() => {
    const SlideIframeComponent = React.memo(
      ({ slide }: { slide: SlideMetadata & { number: number } }) => {
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
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <Presentation className="mx-auto mb-4 h-12 w-12 text-zinc-400" />
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {tHardcodedUi.raw(
                    'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line377JsxTextNoSlideContentToPreview',
                  )}
                </p>
              </div>
            </div>
          );
        }

        const slideUrl = constructHtmlPreviewUrl(slide.file_path, subdomainOpts);
        // Add cache-busting to iframe src to ensure fresh content
        const slideUrlWithCacheBust = `${slideUrl}?t=${refreshTimestamp}`;

        return (
          <div className="flex h-full w-full items-center justify-center bg-transparent">
            <div
              ref={setContainerRef}
              className="relative overflow-hidden rounded-lg bg-transparent"
              style={{
                width: '100%',
                maxWidth: '100%',
                aspectRatio: '16 / 9',
                maxHeight: '100%',
                containIntrinsicSize: '1920px 1080px',
                contain: 'layout style',
              }}
            >
              <iframe
                key={`slide-${slide.number}-${refreshTimestamp}-${showEditor}`} // Key with stable timestamp ensures iframe refreshes when metadata changes
                src={
                  showEditor
                    ? `${sandboxUrl}/api/html/${slide.file_path}/editor`
                    : slideUrlWithCacheBust
                }
                title={`Slide ${slide.number}: ${slide.title}`}
                className="rounded-xl border-0"
                sandbox={PRESENTATION_WITH_MODALS_IFRAME_SANDBOX}
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
                  backfaceVisibility: 'hidden',
                  WebkitBackfaceVisibility: 'hidden',
                }}
              />
            </div>
          </div>
        );
      },
      (prevProps, nextProps) => {
        // Custom comparison function - only re-render if slide number or file_path changes
        return (
          prevProps.slide.number === nextProps.slide.number &&
          prevProps.slide.file_path === nextProps.slide.file_path
        );
      },
    );

    SlideIframeComponent.displayName = 'SlideIframeComponent';
    return SlideIframeComponent;
  }, [sandboxUrl, refreshTimestamp, showEditor, subdomainOpts]);

  if (!isOpen) return null;

  // Render slide iframe with proper scaling
  const renderSlide =
    !currentSlideData || !sandboxUrl ? null : <SlideIframe slide={currentSlideData} />;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm">
      {/* Top Controls Bar */}
      <div className="shrink-0 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0 rounded-2xl border border-zinc-300 bg-zinc-200/60 p-2 dark:border-zinc-700 dark:bg-zinc-900">
              <Presentation className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
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
              className="w-8 p-0"
              title={showEditor ? 'Close editor' : 'Edit presentation'}
              onClick={() => setShowEditor(!showEditor)}
            >
              {showEditor ? (
                <Presentation className="h-3.5 w-3.5" />
              ) : (
                <Edit className="h-3.5 w-3.5" />
              )}
            </Button>

            {/* Export dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-8 p-0"
                  title={tHardcodedUi.raw(
                    'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line485JsxAttrTitleExportPresentation',
                  )}
                  disabled={isDownloadingPDF || isDownloadingPPTX || isDownloadingGoogleSlides}
                >
                  {isDownloadingPDF || isDownloadingPPTX || isDownloadingGoogleSlides ? (
                    <KortixLoader customSize={14} />
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
                  <FileText className="mr-2 h-4 w-4" />
                  PDF
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => handleDownload(DownloadFormat.PPTX)}
                  disabled={isDownloadingPPTX}
                >
                  <Presentation className="mr-2 h-4 w-4" />
                  PPTX
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => handleDownload(DownloadFormat.GOOGLE_SLIDES)}
                  disabled={isDownloadingGoogleSlides}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {tHardcodedUi.raw(
                    'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line518JsxTextGoogleSlides',
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Close button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0"
              title={tHardcodedUi.raw(
                'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line529JsxAttrTitleCloseFullScreen',
              )}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-100 p-2 dark:bg-zinc-900">
        {isLoading || !currentSlideData ? (
          <div className="text-center">
            <KortixLoader size="large" className="mx-auto mb-4" />
            <p className="text-zinc-700 dark:text-zinc-300">
              {retryAttempt > 0
                ? `Retrying... (attempt ${retryAttempt + 1})`
                : 'Loading presentation...'}
            </p>
          </div>
        ) : currentSlideData ? (
          <div className="flex h-full w-full flex-col">
            {/* Presentation Container */}
            <div
              className="flex-1 overflow-hidden rounded-xl bg-transparent"
              style={{ aspectRatio: '16 / 9' }}
            >
              {renderSlide}
            </div>

            {/* Controls below presentation */}
            <div className="mt-3 flex items-center justify-between px-4">
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
                      className={cn(
                        'h-2.5 w-2.5 rounded-full transition-colors duration-200',
                        slide.number === currentSlide
                          ? 'bg-black dark:bg-white'
                          : 'bg-zinc-300 hover:bg-zinc-400 dark:bg-zinc-600 dark:hover:bg-zinc-500',
                      )}
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
            <p className="text-zinc-700 dark:text-zinc-300">
              {tHardcodedUi.raw(
                'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line621JsxTextNoSlideFound',
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
