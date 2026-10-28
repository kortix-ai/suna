'use client';

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
export function ImageFrame({ aspectRatio, src, alt, pending, label, onOpen, className, fill = false, maxHeight, openLabel }: ImageFrameProps) {
  const img = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [natural, setNatural] = useState<string | null>(null);

  // A new source starts hidden at the requested ratio again; a cached one may
  // be complete before React sees `load`.
  useEffect(() => {
    const el = img.current;
    const complete = !!el?.complete && el.naturalWidth > 0;
    setLoaded(complete);
    setNatural(complete && el ? `${el.naturalWidth} / ${el.naturalHeight}` : null);
  }, [src]);

  const onLoad = () => {
    const el = img.current;
    if (el?.naturalWidth && el.naturalHeight) setNatural(`${el.naturalWidth} / ${el.naturalHeight}`);
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
