'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { ImageOff, Maximize2, Minimize2, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

/** What sits behind the artwork. Only meaningful for formats that can be
 *  transparent — an SVG logo is unreadable on the one background that happens
 *  to match its own ink, so the viewer has to be able to say "show me this on
 *  white" and "show me this on black". */
export type ImageBackdrop = 'transparent' | 'white' | 'black';

interface ImageRendererProps {
  url: string;
  className?: string;
  /** Optional file name — shown in the info panel type field */
  fileName?: string;
  /**
   * When the floating control shelf is visible.
   *
   * `'hover'` (default) keeps the chrome out of the way until the pointer
   * arrives — right where the image is one item among many. `'always'` pins it
   * open for surfaces where looking at the artwork IS the task, and moves it to
   * the bottom edge: a permanently-open shelf at the top would sit directly
   * under the host's own toolbar and read as a second toolbar. It is also the
   * only honest option on touch, where hover never fires.
   */
  controls?: 'hover' | 'always';
  /** Add the backdrop swatches to the shelf (see `ImageBackdrop`). Off by
   *  default — an opaque JPEG has exactly one meaningful background. */
  backdrop?: boolean;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [500, 1500, 3000]; // ms — escalating backoff

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 10;

/**
 * The transparency checkerboard, built from `currentColor` so it tints itself
 * from the surrounding theme instead of hard-coding the usual mid-grey — a
 * bright grey/white check is a hole punched in a dark UI. `repeating-conic-
 * gradient` draws the whole pattern in one layer (the four-linear-gradient
 * idiom needs four).
 */
function checkerStyle(tile: number, strength: number): React.CSSProperties {
  return {
    backgroundImage: `repeating-conic-gradient(color-mix(in oklab, currentColor ${strength}%, transparent) 0% 25%, transparent 0% 50%)`,
    backgroundSize: `${tile}px ${tile}px`,
  };
}

/**
 * Two calls, two jobs. Across a 500px canvas the pattern is a texture the eye
 * should read past, so it stays faint and its squares stay big. Inside a 14px
 * swatch it has to survive as an *icon* at a glance — four squares, high
 * enough contrast to say "transparent" rather than "empty" — so it is tighter
 * and stronger. Same idea drawn at two sizes is not the same value.
 */
const CANVAS_CHECKER = checkerStyle(16, 7);
const SWATCH_CHECKER = checkerStyle(7, 26);

/** Swatch order is lightest-to-darkest, and transparent leads because it is the
 *  truthful default: it shows what the file actually contains. */
const BACKDROPS: { value: ImageBackdrop; label: string }[] = [
  { value: 'transparent', label: 'Transparent' },
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
];

export function ImageRenderer({
  url,
  className,
  fileName,
  controls = 'hover',
  backdrop: showBackdrop = false,
}: ImageRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [startPanPosition, setStartPanPosition] = useState({ x: 0, y: 0 });
  const [isFitToScreen, setIsFitToScreen] = useState(true);
  const [backdrop, setBackdrop] = useState<ImageBackdrop>('transparent');
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

  // Check if the url is an SVG. The file name is checked FIRST because a caller
  // that built the URL itself — `FileViewer` turns SVG source text into a
  // `blob:` URL — has a URL carrying no extension and no MIME to sniff.
  const isSvg =
    fileName?.toLowerCase().endsWith('.svg') ||
    url?.toLowerCase().endsWith('.svg') ||
    url?.includes('image/svg');

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
  const alwaysOn = controls === 'always';

  return (
    <div className={cn('group relative h-full w-full', className)}>
      {/* Floating controls — reveal on hover or keyboard focus; pinned open
          while the info panel is. Opacity-only (no movement) so rapid
          hover-in/out retargets cleanly. `controls="always"` opts out of the
          reveal entirely and moves the shelf to the bottom edge (see the prop's
          doc comment). */}
      {!imgError && (
        <div
          className={cn(
            'absolute left-1/2 z-10 -translate-x-1/2',
            alwaysOn
              ? 'bottom-3'
              : [
                  'top-3 opacity-0 transition-opacity duration-200 ease-out',
                  'group-hover:opacity-100 focus-within:opacity-100',
                  showInfo && 'opacity-100',
                ],
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
            {/* Backdrop swatches join the SAME group behind a separator rather
                than floating as a second shelf — one row of chrome over the
                canvas, not two competing ones. The glyph IS the colour: a
                labelled icon would need the user to translate a metaphor back
                into "what will the background look like", when the answer can
                just be shown. */}
            {showBackdrop && (
              <>
                <ButtonGroupSeparator />
                {BACKDROPS.map(({ value, label }) => (
                  <Hint key={value} label={`${label} background`} side="bottom">
                    <Button
                      variant="accent"
                      size="icon"
                      className="text-foreground"
                      onClick={() => setBackdrop(value)}
                      aria-label={`${label} background`}
                      aria-pressed={backdrop === value}
                    >
                      <span
                        className={cn(
                          // A hairline on every swatch, not just the white one:
                          // without it the white chip vanishes on a light
                          // toolbar and the black one on a dark toolbar.
                          'border-foreground/20 size-3.5 rounded-[3px] border',
                          // The selected swatch gets a ring rather than a
                          // filled/inverted button, so the three chips stay
                          // readable as a colour comparison.
                          backdrop === value && 'ring-foreground/60 ring-2 ring-offset-1',
                          'ring-offset-background',
                          value === 'white' && 'bg-white',
                          value === 'black' && 'bg-black',
                        )}
                        style={value === 'transparent' ? SWATCH_CHECKER : undefined}
                      />
                    </Button>
                  </Hint>
                ))}
              </>
            )}
          </ButtonGroup>
        </div>
      )}

      {/* Image container - Clean background */}
      <div
        ref={containerRef}
        className={cn(
          'relative h-full w-full overflow-hidden select-none',
          // `bg-white`/`bg-black` are the one place raw colours are correct:
          // these are not UI chrome picking up the theme, they are the literal
          // white and black the user asked to see the artwork against.
          !showBackdrop || backdrop === 'transparent'
            ? 'text-foreground bg-background'
            : backdrop === 'white'
              ? 'bg-white'
              : 'bg-black',
        )}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onDoubleClick={imgError ? undefined : toggleFitToScreen}
        style={{
          cursor: isPanning ? 'grabbing' : !isFitToScreen ? 'grab' : 'default',
          ...(showBackdrop && backdrop === 'transparent' ? CANVAS_CHECKER : null),
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
