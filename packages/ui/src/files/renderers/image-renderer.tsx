'use client';

import { useTranslations } from '../../i18n';
import { useLocalizedUiCatalog } from '../../i18n/ui-catalog/use-localized-ui-catalog';

import { Button } from '../../primitives/button';
import { ButtonGroup, ButtonGroupSeparator } from '../../primitives/button-group';
import Hint from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { IconInfo } from '../../primitives/kortix-icons';
import { DisclosureTrigger } from '../../primitives/disclosure';
import { usePreviewFit } from '../viewer/preview-fit';
import { cn } from '../../lib/utils';
import {
  ImageBrokenIcon as ImageOff,
  ArrowClockwiseIcon as RotateCw,
  MagnifyingGlassPlusIcon as ZoomIn,
  MagnifyingGlassMinusIcon as ZoomOut,
} from '@phosphor-icons/react';
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
   * only honest option on touch, where hover never fires. `'none'` draws no
   * shelf: a thumbnail is opened to be looked at, never zoomed in place.
   */
  controls?: 'hover' | 'always' | 'none';
  /** Add the backdrop swatches to the shelf (see `ImageBackdrop`). Off by
   *  default — an opaque JPEG has exactly one meaningful background. */
  backdrop?: boolean;
  /**
   * The image's details toggle (ⓘ), last on the shelf: shown only when the
   * host has details for this image (a generated image's prompt and model).
   * It is a `DisclosureTrigger`: the host renders this renderer inside the
   * `Disclosure` whose content holds the details.
   */
  info?: { pressed: boolean; label: string };
}

/**
 * The details toggle: a `DisclosureTrigger` (toggle, Enter/Space,
 * `aria-expanded`) around the shelf's button. Props and ref pass through, so
 * the tooltip trigger around it still works.
 */
function InfoTrigger({ pressed, label, ...props }: { pressed: boolean; label: string } & React.ComponentProps<typeof Button>) {
  return (
    <DisclosureTrigger>
      <Button {...props} variant="secondary" size="icon-base" aria-label={label} aria-pressed={pressed} data-image-info="">
        <IconInfo className="size-4" weight={pressed ? 'fill' : 'regular'} />
      </Button>
    </DisclosureTrigger>
  );
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
  info,
}: ImageRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const backdrops = useLocalizedUiCatalog(BACKDROPS);
  // `null` outside a <PreviewFitProvider> (Advanced-mode viewer, /projects
  // previews, the file-preview modal, share pages) — `report` below is then
  // an inert no-op, which is how this stays byte-identical everywhere except
  // the Easy panel.
  const previewFit = usePreviewFit();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const startPanPositionRef = useRef({ x: 0, y: 0 });
  const [backdrop, setBackdrop] = useState<ImageBackdrop>('transparent');
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  // ── Retry state ──────────────────────────────────────────────────────
  const [retryCount, setRetryCount] = useState(0);
  const [imgSrc, setImgSrc] = useState(url);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const imageRef = useRef<HTMLImageElement>(null);

  // Check if the url is an SVG. The file name is checked FIRST because a caller
  // that built the URL itself — `FileViewer` turns SVG source text into a
  // `blob:` URL — has a URL carrying no extension and no MIME to sniff.
  const isSvg =
    fileName?.toLowerCase().endsWith('.svg') ||
    url?.toLowerCase().endsWith('.svg') ||
    url?.includes('image/svg');

  // When the parent passes a new URL, reset everything. The reset runs during
  // render, not in an effect: an effect also ran on mount, after a cached
  // image had already fired `load`, and set `imgLoaded` back to false. The
  // `src` never changed again, so no second `load` came and the spinner
  // stayed forever (a Drive card whose file opened instantly).
  const [shownUrl, setShownUrl] = useState(url);
  if (url !== shownUrl) {
    setShownUrl(url);
    setImgSrc(url);
    setImgLoaded(false);
    setImgError(false);
    setRetryCount(0);
  }
  useEffect(() => {
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

  // Once the image is back to 1x or smaller it fits its container again, so any
  // pan offset is stale — drop it.
  useEffect(() => {
    if (zoom <= 1) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom]);

  // Handle image load success
  const handleImageLoad = useCallback(() => {
    setImgLoaded(true);
    setImgError(false);
    setRetryCount(0); // reset on success

    if (imageRef.current) {
      previewFit?.report({
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
      });
    }
  }, [previewFit]);

  // Retries exhausted: these bytes are never going to decode, so there will be
  // no `report` for this image. Say "never" rather than staying silent — a
  // consumer reads silence as "still loading" and keeps whatever width it last
  // measured. Guarded on `previewFit`, so this is inert everywhere but the
  // Easy panel, exactly like `report`.
  useEffect(() => {
    if (!previewFit || !imgError) return;
    previewFit.reportUnmeasurable();
  }, [previewFit, imgError]);

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
  };

  const handleZoomOut = () => {
    setZoom((prev) => {
      const step = getZoomStep(prev - 0.01); // step based on where we're going
      return Math.max(prev - step, MIN_ZOOM);
    });
  };

  // Back to the fitted default — the % readout doubles as the reset control
  const handleResetZoom = () => {
    setZoom(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  };

  // Deliberately no wheel/trackpad zoom. Zoom changes only from the shelf
  // buttons (and the reset readout), so scrolling over an image scrolls the
  // surrounding list instead of silently rescaling the artwork.

  // Function for rotation
  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  // Panning is only meaningful once the image is bigger than its container —
  // that is exactly `zoom > 1`, since the img is `object-contain` and already
  // fits at 1x. Derived from `zoom` rather than tracked as its own flag, so the
  // two can never disagree.
  const canPan = zoom > 1;

  // Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (canPan) {
      setIsPanning(true);
      startPanPositionRef.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning && canPan) {
      setPosition({
        x: e.clientX - startPanPositionRef.current.x,
        y: e.clientY - startPanPositionRef.current.y,
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
  const alwaysOn = controls === 'always';

  return (
    <div className={cn('group relative h-full w-full', className)}>
      {/* Floating controls — reveal on hover or keyboard focus; pinned open
          while the info panel is. Opacity-only (no movement) so rapid
          hover-in/out retargets cleanly. `controls="always"` opts out of the
          reveal entirely and moves the shelf to the bottom edge (see the prop's
          doc comment). */}
      {!imgError && controls !== 'none' && (
        <div
          className={cn(
            'absolute left-1/2 z-10 -translate-x-1/2',
            alwaysOn
              ? 'bottom-1'
              : [
                  'top-1 opacity-0 transition-opacity duration-200 ease-out',
                  'group-hover:opacity-100 focus-within:opacity-100',
                  (showInfo || info?.pressed) && 'opacity-100',
                ],
          )}
        >
          <ButtonGroup>
            <Hint label={zoomOutLabel} side="bottom">
              <Button
                variant="secondary"
                size="icon-base"
                onClick={handleZoomOut}
                disabled={zoom <= MIN_ZOOM}
                aria-label={zoomOutLabel}
              >
                <ZoomOut className="size-4" />
              </Button>
            </Hint>
            <Hint label={tHardcodedUi.raw('i18nComplete.textce89ae822e8b')} side="bottom">
              <Button
                variant="secondary"
                size="sm"
                className="min-w-14 tabular-nums"
                onClick={handleResetZoom}
                aria-label={tHardcodedUi.raw('i18nComplete.textce89ae822e8b')}
              >
                {Math.round(zoom * 100)}%
              </Button>
            </Hint>
            <Hint label={zoomInLabel} side="bottom">
              <Button
                variant="secondary"
                size="icon-base"
                onClick={handleZoomIn}
                disabled={zoom >= MAX_ZOOM}
                aria-label={zoomInLabel}
              >
                <ZoomIn className="size-4" />
              </Button>
            </Hint>
            <Hint label={tHardcodedUi.raw('i18nComplete.textc3613b1704f5')} side="bottom">
              <Button
                variant="secondary"
                size="icon-base"
                onClick={handleRotate}
                aria-label={tHardcodedUi.raw('i18nComplete.text9dc6b57eecba')}
              >
                <RotateCw className="size-4" />
              </Button>
            </Hint>
            {info ? (
              <Hint label={info.label} side="bottom">
                <InfoTrigger pressed={info.pressed} label={info.label} />
              </Hint>
            ) : null}
            {/* Backdrop swatches join the SAME group behind a separator rather
                than floating as a second shelf — one row of chrome over the
                canvas, not two competing ones. The glyph IS the colour: a
                labelled icon would need the user to translate a metaphor back
                into "what will the background look like", when the answer can
                just be shown. */}
            {showBackdrop && (
              <>
                <ButtonGroupSeparator />
                {backdrops.map(({ value, label }) => (
                  <Hint key={value} label={`${label} background`} side="bottom">
                    <Button
                      variant="secondary"
                      size="icon-base"
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
        className={cn(
          'relative h-full w-full overflow-hidden select-none',
          // `bg-white`/`bg-black` are the one place raw colours are correct:
          // these are not UI chrome picking up the theme, they are the literal
          // white and black the user asked to see the artwork against.
          !showBackdrop || backdrop === 'transparent'
            ? 'text-foreground bg-secondary'
            : backdrop === 'white'
              ? 'bg-white'
              : 'bg-black',
        )}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{
          cursor: isPanning ? 'grabbing' : canPan ? 'grab' : 'default',
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
              {tHardcodedUi.raw('i18nComplete.textd8b8392e2c54')}
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
                transform: canPan ? translateTransform : 'none',
                transition: isPanning ? 'none' : "transform 0.1s ease-out",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                src={imgSrc}
                alt={
                  fileName ??
                  (isSvg
                    ? tHardcodedUi.raw('i18nComplete.text2c92015509d0')
                    : tHardcodedUi.raw('i18nComplete.textf09247433bef'))
                }
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
