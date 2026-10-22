'use client';

import Image from 'next/image';

/**
 * A real screenshot of the product, framed like a window rather than dropped in
 * bare. `unoptimized` keeps the already-downscaled webp byte-for-byte — the
 * asset is pre-sized to 1800px, so re-encoding only costs sharpness.
 */
export function ProductShot({
  src,
  alt,
  caption,
  priority = false,
}: {
  src: string;
  alt: string;
  caption: string;
  priority?: boolean;
}) {
  return (
    <figure className="mt-10">
      <div className="border-border bg-card overflow-hidden rounded-sm border">
        <div className="border-border/70 flex h-9 items-center gap-1.5 border-b px-4">
          <span aria-hidden className="bg-foreground/15 size-2 rounded-full" />
          <span aria-hidden className="bg-foreground/15 size-2 rounded-full" />
          <span aria-hidden className="bg-foreground/15 size-2 rounded-full" />
        </div>
        <Image
          src={src}
          alt={alt}
          width={1800}
          height={1100}
          priority={priority}
          unoptimized
          className="h-auto w-full"
        />
      </div>
      <figcaption className="text-muted-foreground mt-3 font-mono text-[11px] tracking-wide">
        {caption}
      </figcaption>
    </figure>
  );
}
