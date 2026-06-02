'use client';

/**
 * StepMedia — a browser-framed media slot for the landing-page walkthrough.
 *
 * Renders the right element based on the file extension, so a screenshot can be
 * swapped for a screen-recorded loop later with ZERO code change — just drop a
 * `.mp4`/`.webm`/`.gif` at the same path and update the `src`:
 *   - .mp4 / .webm → autoplaying, muted, looping <video>
 *   - .gif         → <img>
 *   - .png/.jpg/…  → next/Image
 */

import Image from 'next/image';
import { cn } from '@/lib/utils';

export function StepMedia({
  src,
  alt,
  urlLabel = 'acme.kortix.app',
  priority = false,
  className,
}: {
  src: string;
  alt: string;
  urlLabel?: string;
  priority?: boolean;
  className?: string;
}) {
  const ext = src.split('.').pop()?.toLowerCase();
  const isVideo = ext === 'mp4' || ext === 'webm';
  const isGif = ext === 'gif';

  return (
    <div className={cn('overflow-hidden rounded-[20px] border border-border bg-background shadow-2xl ring-1 ring-black/[0.02]', className)}>
      {/* browser chrome */}
      <div className="flex h-11 items-center gap-3 border-b border-border/60 bg-muted/30 px-4">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-muted-foreground/15" />
          <span className="size-2.5 rounded-full bg-muted-foreground/15" />
          <span className="size-2.5 rounded-full bg-muted-foreground/15" />
        </div>
        <div className="mx-auto flex h-7 w-full max-w-xs items-center justify-center gap-2 rounded-full border border-border bg-background px-3 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {urlLabel}
        </div>
        <div className="w-12" />
      </div>

      {/* media */}
      <div className="relative aspect-[1440/900] w-full bg-muted/20">
        {isVideo ? (
          <video
            src={src}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            aria-label={alt}
            className="absolute inset-0 size-full object-cover object-top"
          />
        ) : isGif ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt} className="absolute inset-0 size-full object-cover object-top" loading="lazy" decoding="async" />
        ) : (
          <Image src={src} alt={alt} fill priority={priority} sizes="(max-width: 1024px) 100vw, 1024px" className="object-cover object-top" />
        )}
      </div>
    </div>
  );
}
