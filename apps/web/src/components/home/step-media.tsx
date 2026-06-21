'use client';

import { useTranslations } from 'next-intl';
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

import { cn } from '@/lib/utils';
import Image from 'next/image';

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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const ext = src.split('.').pop()?.toLowerCase();
  const isVideo = ext === 'mp4' || ext === 'webm';
  const isGif = ext === 'gif';

  return (
    <div
      className={cn(
        'border-border bg-background overflow-hidden rounded-[20px] border shadow-2xl ring-1 ring-black/[0.02]',
        className,
      )}
    >
      {/* browser chrome */}
      <div className="border-border/60 bg-muted/30 flex h-11 items-center gap-3 border-b px-4">
        <div className="flex gap-1.5">
          <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
        </div>
        <div className="border-border bg-background text-muted-foreground mx-auto flex h-7 w-full max-w-xs items-center justify-center gap-2 rounded-full border px-3 text-xs">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {urlLabel}
        </div>
        <div className="w-12" />
      </div>

      {/* media */}
      <div className="bg-muted/20 relative aspect-[1440/900] w-full">
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
          <img
            src={src}
            alt={alt}
            className="absolute inset-0 size-full object-cover object-top"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <Image
            src={src}
            alt={alt}
            fill
            priority={priority}
            sizes={tI18nHardcoded.raw(
              'autoComponentsHomeStepMediaJsxAttrSizesMaxWidth1024px9d9619e1',
            )}
            className="object-cover object-top"
          />
        )}
      </div>
    </div>
  );
}
