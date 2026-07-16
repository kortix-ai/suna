'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { ImageOff, Maximize2, Minimize2, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ImageRendererProps {
  url: string;
  className?: string;
  /** Optional file name — shown in the info panel type field */
  fileName?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [500, 1500, 3000]; // ms — escalating backoff

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 10;

export function ImageRenderer({ url, className, fileName }: ImageRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [startPanPosition, setStartPanPosition] = useState({ x: 0, y: 0 });
  const [isFitToScreen, setIsFitToScreen] = useState(true);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [imgInfo, setImgInfo] = useState<{
    width: number;
    height: number;
    type: string;
  } | null>(null);

  // ── Retry state ──────────────────────────────────────────────────────
  const [retryCount, setRetryCount] = useState(0);
  const [imgSrc, setImgSrc] = useState(url);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Check if the url is an SVG
  const isSvg = url?.toLowerCase().endsWith('.svg') || url?.includes('image/svg');

  // Derive the display file type for the info panel
  const displayFileType = (() => {
    if (isSvg) return 'SVG';
    if (fileName) {
      const ext = fileName.split('.').pop()?.toUpperCase();
      if (ext) return ext;
    }
    const ext = url.split('.').pop()?.toUpperCase();
    return ext || 'Image';
  })();

  // When the parent passes a new URL, reset everything
  useEffect(() => {
    setImgSrc(url);
    setImgLoaded(false);
    setImgError(false);
    setRetryCount(0);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [url]);

  // Cleanup retry timer on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  // Reset position when zoom changes
  useEffect(() => {
    if (isFitToScreen) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom, isFitToScreen]);

  // Handle image load success
  const handleImageLoad = useCallback(() => {
    setImgLoaded(true);
    setImgError(false);
    setRetryCount(0); // reset on success

    if (imageRef.current) {
      setImgInfo({
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
        type: displayFileType,
      });
    }
  }, [displayFileType]);

  // Force the browser to re-attempt by toggling the src. For blob: URLs a
  // cache-bust param doesn't help, so we briefly clear and re-set the src.
  const reloadImage = useCallback(() => {
    setImgSrc('');
    // Use rAF to ensure the empty src is committed before re-setting
    requestAnimationFrame(() => {
      setImgSrc(url);
    });
  }, [url]);

  // Handle image load error — auto-retry with backoff
  const handleImageError = useCallback(() => {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAYS[retryCount] ?? 3000;
      retryTimerRef.current = setTimeout(() => {
        reloadImage();
        setRetryCount((c) => c + 1);
      }, delay);
    } else {
      // All retries exhausted
      setImgLoaded(false);
      setImgError(true);
    }
  }, [retryCount, reloadImage]);

  // Manual retry from the error state — restart the whole backoff cycle
  const handleRetry = useCallback(() => {
    setImgError(false);
    setRetryCount(0);
    reloadImage();
  }, [reloadImage]);

  // Functions for zooming — adaptive step: 0.25 up to 2x, 0.5 up to 5x, 1.0 above
  const getZoomStep = (currentZoom: number) => {
    if (currentZoom < 2) return 0.25;
    if (currentZoom < 5) return 0.5;
    return 1;
  };

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev + getZoomStep(prev), MAX_ZOOM));
    setIsFitToScreen(false);
  };

  const handleZoomOut = () => {
    setZoom((prev) => {
      const step = getZoomStep(prev - 0.01); // step based on where we're going
      const newZoom = Math.max(prev - step, MIN_ZOOM);
      if (newZoom <= 0.5) setIsFitToScreen(true);
      return newZoom;
    });
  };

  // Back to the fitted default — the % readout doubles as the reset control
  const handleResetZoom = () => {
    setZoom(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
    setIsFitToScreen(true);
  };

  // Scroll wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -1 : 1;
    setZoom((prev) => {
      const step = getZoomStep(prev) * 0.5;
      const next = Math.max(MIN_ZOOM, Math.min(prev + delta * step, MAX_ZOOM));
      if (next <= 0.5) setIsFitToScreen(true);
      else setIsFitToScreen(false);
      return next;
    });
  };

  // Function for rotation
  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  // Toggle fit to screen
  const toggleFitToScreen = () => {
    if (isFitToScreen) {
      setZoom(1);
      setIsFitToScreen(false);
    } else {
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setIsFitToScreen(true);
    }
  };

  // Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isFitToScreen) {
      setIsPanning(true);
      setStartPanPosition({
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning && !isFitToScreen) {
      setPosition({
        x: e.clientX - startPanPosition.x,
        y: e.clientY - startPanPosition.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleMouseLeave = () => {
    setIsPanning(false);
  };

  // Calculate transform styles
  const imageTransform = `scale(${zoom}) rotate(${rotation}deg)`;
  const translateTransform = `translate(${position.x}px, ${position.y}px)`;

  // Show image info
  const [showInfo, setShowInfo] = useState(false);

  const isLoading = !imgLoaded && !imgError;

  const zoomOutLabel = tHardcodedUi.raw(
    'componentsFileRenderersImageRenderer.line234JsxAttrTitleZoomOut',
  );
  const zoomInLabel = tHardcodedUi.raw(
    'componentsFileRenderersImageRenderer.line247JsxAttrTitleZoomIn',
  );
  const infoLabel = tHardcodedUi.raw(
    'componentsFileRenderersImageRenderer.line287JsxAttrTitleImageInformation',
  );
  const fitLabel = isFitToScreen ? 'Actual size' : 'Fit to screen';

  return (
    <div className={cn('group relative h-full w-full', className)}>
      {/* Floating controls — reveal on hover or keyboard focus; pinned open
          while the info panel is. Opacity-only (no movement) so rapid
          hover-in/out retargets cleanly. */}
      {!imgError && (
        <div
          className={cn(
            'absolute top-3 left-1/2 z-10 -translate-x-1/2',
            'opacity-0 transition-opacity duration-200 ease-out',
            'group-hover:opacity-100 focus-within:opacity-100',
            showInfo && 'opacity-100',
          )}
        >
          <ButtonGroup className="bg-background rounded-md border shadow-sm">
            <Hint label={zoomOutLabel} side="bottom">
              <Button
                variant="accent"
                size="icon"
                className="text-foreground"
                onClick={handleZoomOut}
                disabled={zoom <= MIN_ZOOM}
                aria-label={zoomOutLabel}
              >
                <ZoomOut className="size-4" />
              </Button>
            </Hint>
            <Hint label="Reset view" side="bottom">
              <Button
                variant="accent"
                size="toolbar"
                className="text-foreground min-w-14 tabular-nums"
                onClick={handleResetZoom}
                aria-label="Reset view"
              >
                {Math.round(zoom * 100)}%
              </Button>
            </Hint>
            <Hint label={zoomInLabel} side="bottom">
              <Button
                variant="accent"
                size="icon"
                className="text-foreground"
                onClick={handleZoomIn}
                disabled={zoom >= MAX_ZOOM}
                aria-label={zoomInLabel}
              >
                <ZoomIn className="size-4" />
              </Button>
            </Hint>
            <Hint label="Rotate" side="bottom">
              <Button
                variant="accent"
                size="icon"
                className="text-foreground"
                onClick={handleRotate}
                aria-label="Rotate image"
              >
                <RotateCw className="size-4" />
              </Button>
            </Hint>
            <Hint label={fitLabel} side="bottom">
              <Button
                variant="accent"
                size="icon"
                className="text-foreground"
                onClick={toggleFitToScreen}
                aria-label={fitLabel}
              >
                {isFitToScreen ? (
                  <Maximize2 className="size-4" />
                ) : (
                  <Minimize2 className="size-4" />
                )}
              </Button>
            </Hint>
          </ButtonGroup>
        </div>
      )}

      {/* Image container - Clean background */}
      <div
        ref={containerRef}
        className="bg-background relative h-full w-full overflow-hidden select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onDoubleClick={imgError ? undefined : toggleFitToScreen}
        style={{
          cursor: isPanning ? 'grabbing' : !isFitToScreen ? 'grab' : 'default',
        }}
      >
        {imgError ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <span className="bg-muted/60 flex size-9 items-center justify-center rounded-sm">
              <ImageOff className="text-muted-foreground size-5" />
            </span>
            <div className="space-y-1">
              <p className="text-foreground text-sm font-medium">
                {tHardcodedUi.raw(
                  'componentsFileRenderersImageRenderer.line330JsxTextFailedToLoadImage',
                )}
              </p>
              <p className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsFileRenderersImageRenderer.line333JsxTextTheImageCouldNotBeDisplayed',
                )}
              </p>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRetry}>
              <RotateCw className="size-4" />
              Try again
            </Button>
          </div>
        ) : (
          <>
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loading className="size-5" />
              </div>
            )}
            <div
              className="absolute inset-0 flex items-center justify-center p-8"
              style={{
                transform: isFitToScreen ? 'none' : translateTransform,
                transition: isPanning ? 'none' : 'transform 0.1s ease-out',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                src={imgSrc}
                alt={fileName ?? (isSvg ? 'SVG preview' : 'Image preview')}
                className={cn(
                  'max-h-full max-w-full object-contain',
                  // Fade in on load instead of popping; opacity and transform
                  // enumerated — never `transition: all`.
                  'transition-[opacity,transform] duration-200 ease-out',
                  imgLoaded ? 'opacity-100' : 'opacity-0',
                  // A soft lift so the image reads as content over the canvas.
                  // SVGs are usually transparent artwork — a shadow under them
                  // draws a box that isn't there.
                  imgLoaded && !isSvg && 'shadow-md',
                )}
                style={{ transform: imageTransform }}
                draggable={false}
                onLoad={handleImageLoad}
                onError={handleImageError}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
