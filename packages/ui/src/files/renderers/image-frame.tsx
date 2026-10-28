'use client';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { cn } from '../../lib/utils';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface ImageFrameProps {
  /** CSS `aspect-ratio` before the image loads (`"3 / 2"`); the image's natural size replaces it on load. */
  aspectRatio: string;
  src: string | null;
  alt: string;
  /** The image does not exist yet, or its bytes are on the way. */
  pending: boolean;
  /** Centered over the frame: the busy line, or a note. */
  label?: ReactNode;
  /** Makes the image a button (open it in the file viewer). */
  onOpen?: () => void;
  className?: string;
  /**
   * Fill the parent's box (a tile of a layout) and crop the image to it
   * (`object-cover`), in place of holding `aspectRatio` and fitting the image.
   */
  fill?: boolean;
  /**
   * The tallest the frame may be (`'60vh'`): it narrows to keep its ratio,
   * so it never crops more and never letterboxes. Unset: the full width.
   */
  maxHeight?: string;
  /** The image button's accessible name; `alt` when unset. */
  openLabel?: string;
  /** The image's natural ratio when another surface already measured it (`"<w> / <h>"`), so a remount starts at it. */
  naturalRatio?: string | null;
  /** Reports the image's natural size once it decoded. */
  onNaturalSize?: (width: number, height: number) => void;
}

/** `'3 / 2'` → `1.5`; anything unreadable → `1`. */
function ratioValue(ratio: string): number {
  const [w, h] = ratio.split('/').map((part) => Number(part.trim()));
  return w && h ? w / h : 1;
}

/**
 * The box an image takes before, while and after it exists: a flat `bg-muted`
 * surface that holds the requested aspect ratio before any pixel arrives, so
 * the layout does not jump when the image lands, then fades the image in.
 * The frame itself never moves: the busy signal is the label (one waiting
 * channel, kortix-brand `layout.md` States).
 */
export function ImageFrame({
  aspectRatio,
  src,
  alt,
  pending,
  label,
  onOpen,
  className,
  fill = false,
  maxHeight,
  openLabel,
  naturalRatio = null,
  onNaturalSize,
}: ImageFrameProps) {
  const img = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [natural, setNatural] = useState<string | null>(naturalRatio);

  // A new source starts hidden at the requested ratio again; a cached one may
  // be complete before React sees `load`.
  useEffect(() => {
    const el = img.current;
    const complete = !!el?.complete && el.naturalWidth > 0;
    setLoaded(complete);
    setNatural(complete && el ? `${el.naturalWidth} / ${el.naturalHeight}` : naturalRatio);
    // The ratio is the cached one until this source decodes; a new source is measured on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const onLoad = () => {
    const el = img.current;
    if (el?.naturalWidth && el.naturalHeight) {
      setNatural(`${el.naturalWidth} / ${el.naturalHeight}`);
      onNaturalSize?.(el.naturalWidth, el.naturalHeight);
    }
    setLoaded(true);
  };

  const image = src ? (
    // eslint-disable-next-line @next/next/no-img-element -- a blob: URL of a sandbox file; the Next loader cannot fetch it
    <img
      ref={img}
      src={src}
      alt={alt}
      onLoad={onLoad}
      className={cn(
        'size-full transition-[opacity,filter] duration-moderate ease-out motion-reduce:blur-none',
        fill ? 'object-cover' : 'object-contain',
        loaded ? 'opacity-100 blur-none' : 'opacity-0 blur-xs',
      )}
    />
  ) : null;

  return (
    <div
      aria-busy={pending}
      className={cn('bg-muted relative w-full overflow-hidden rounded-md', fill && 'h-full', className)}
      style={
        fill
          ? undefined
          : {
              aspectRatio: natural ?? aspectRatio,
              ...(maxHeight && { width: `min(100%, calc(${maxHeight} * ${ratioValue(natural ?? aspectRatio)}))` }),
            }
      }
    >
      {image && onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel ?? alt}
          className="focus-visible:ring-kortix-base block size-full cursor-zoom-in rounded-md focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
        >
          {image}
        </button>
      ) : (
        image
      )}
      {label ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center">{label}</div>
      ) : null}
    </div>
  );
}

/**
 * An image whose file could not be read: "Image unavailable" and Try again,
 * centered in the frame. Never the read's own error text (R38): that is
 * internal (a status line, a path, a stack), not something a reader can act on.
 */
export function ImageUnavailable({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('imageGen');
  return (
    <span className="text-muted-foreground flex flex-col items-center gap-2 text-xs">
      {t('unavailable')}
      <Button type="button" variant="secondary" size="sm" className="active:scale-[0.96]" onClick={onRetry}>
        {t('tryAgain')}
      </Button>
    </span>
  );
}

