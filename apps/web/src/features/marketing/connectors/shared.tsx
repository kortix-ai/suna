'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import type { ReactNode } from 'react';

/**
 * The one section shell this page uses. Every section is the same width, the
 * same rhythm, and the same header shape, so the page reads as one document
 * rather than a stack of blocks. Matches the landing page shell exactly.
 */
export function Section({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('mx-auto max-w-7xl px-6 py-24 sm:py-30', className)}>
      {children}
    </section>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  sub,
  className,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  className?: string;
}) {
  return (
    <Reveal>
      <div className={cn('max-w-3xl', className)}>
        <Badge variant="kortix" className="rounded">
          {eyebrow}
        </Badge>
        <h2 className="text-foreground mt-6 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
          {title}
        </h2>
        {sub ? (
          <p className="text-muted-foreground mt-4 text-base leading-relaxed">{sub}</p>
        ) : null}
      </div>
    </Reveal>
  );
}

/** A mono uppercase label. Used for the small in-diagram headings. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground font-mono text-[10px] tracking-widest uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
}

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
