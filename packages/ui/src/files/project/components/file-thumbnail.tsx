'use client';

import { Badge } from '../../../primitives/badge';
import Loading from '../../../primitives/loading';
import { cn } from '../../../lib/utils';
import { chalkColors } from '@kortix/shared';
import { useCallback, useRef, useState } from 'react';
import { FileContentRenderer, getFileCategory } from './file-content-renderer';

interface FileThumbnailProps {
  filePath: string;
  fileName: string;
  className?: string;
  /**
   * Render a lightweight placeholder instead of the live preview. Without it,
   * the card shows the placeholder until it comes near the viewport.
   */
  deferPreview?: boolean;
}

/** How far outside the viewport a card mounts its live preview. */
export const THUMBNAIL_NEAR_MARGIN = '400px';

/**
 * True once the element comes within `THUMBNAIL_NEAR_MARGIN` of the
 * viewport, and from then on. A grid page holds up to 500 cards (KRTX-1723),
 * and every live preview fetches and renders its file: 500 at once froze the
 * page. Without IntersectionObserver every card mounts its preview.
 */
export function useNearViewport<T extends Element>(): [(node: T | null) => void, boolean] {
  const [near, setNear] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.current?.disconnect();
        observer.current = null;
        setNear(true);
      },
      { rootMargin: THUMBNAIL_NEAR_MARGIN },
    );
    observer.current.observe(node);
  }, []);
  return [ref, near];
}

const THUMB_SCALE = 0.28;
const VIRTUAL_PCT = `${100 / THUMB_SCALE}%`;

/**
 * File preview thumbnail. Uses the SAME FileContentRenderer as the full file
 * viewer — so the preview and the opened file are rendered by identical
 * components end-to-end. A uniform CSS scale shrinks the viewport so the
 * rendered output reads as a zoomed-out thumbnail.
 */
export function FileThumbnail({ filePath, fileName, className, deferPreview }: FileThumbnailProps) {
  const extLower = fileName.split('.').pop()?.toLowerCase() || '';
  // An SVG is an `image` by extension but arrives as TEXT, so
  // `FileContentRenderer` draws its SOURCE — `imageDataUrl` only forms for
  // base64 bytes with an `image/*` mime (file-content-renderer.tsx:545). The
  // image branch below deliberately skips the scale, because a picture fills
  // its box on its own; source does not. An SVG therefore took the picture
  // sizing and rendered `<svg xmlns="…" width="1600"` at full size inside a
  // 120px card. It is a code preview, so it is scaled like one.
  const rendersAsPicture = getFileCategory(fileName) === 'image' && extLower !== 'svg';
  const ext = fileName.includes('.') ? extLower.toUpperCase() : '';
  const extChalk = ext ? chalkColors(ext) : null;

  const extBadge =
    ext && !rendersAsPicture && extChalk ? (
      <Badge
        variant="transparent"
        size="xs"
        className="absolute right-2 bottom-2 z-10 border font-semibold tracking-wider uppercase backdrop-blur-sm"
        style={{
          backgroundColor: extChalk.background,
          color: extChalk.foreground,
          borderColor: extChalk.border,
        }}
      >
        {ext}
      </Badge>
    ) : null;

  const [nearRef, near] = useNearViewport<HTMLDivElement>();

  if (deferPreview || !near) {
    return (
      <div
        ref={deferPreview ? undefined : nearRef}
        data-thumbnail-deferred
        className={cn('bg-popover relative overflow-hidden rounded-md', className)}
      >
        <div className="flex h-full w-full items-center justify-center">
          <Loading className="text-muted-foreground/40 size-4" />
        </div>
        {extBadge}
      </div>
    );
  }

  return (
    <div className={cn('bg-popover relative overflow-hidden rounded-md', className)}>
      <div
        className="pointer-events-none absolute top-0 left-0 origin-top-left select-none [&_*]:!cursor-default"
        style={
          rendersAsPicture
            ? { width: '100%', height: '100%' }
            : {
                transform: `scale(${THUMB_SCALE})`,
                width: VIRTUAL_PCT,
                height: VIRTUAL_PCT,
              }
        }
        aria-hidden
      >
        <FileContentRenderer filePath={filePath} readOnly showHeader={false} imageControls="none" />
      </div>
      {extBadge}
    </div>
  );
}
