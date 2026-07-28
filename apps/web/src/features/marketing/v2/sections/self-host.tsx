'use client';

import { SELF_HOST } from '@/features/marketing/v2/content';
import { CheckLine, Heading } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import Link from 'next/link';

const CLOUDS = ['AWS', 'Google Cloud', 'Azure', 'On premise'];

export function SelfHostSection() {
  return (
    <section id="self-host" className="scroll-mt-24 px-6 py-10">
      <div
        className="mx-auto max-w-6xl overflow-hidden rounded-3xl px-6 py-16 sm:px-12 sm:py-20"
        style={{
          background:
            'linear-gradient(150deg, color-mix(in oklab, var(--kortix-blue) 6%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 13%, var(--background)) 100%)',
        }}
      >
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <Heading lines={SELF_HOST.heading} />
            <Link
              href="/enterprise"
              className="bg-foreground text-background hover:bg-foreground/90 mt-8 inline-flex h-11 items-center rounded-full px-6 text-sm font-medium transition-colors"
            >
              {SELF_HOST.cta}
            </Link>
          </div>

          <div>
            <p className="text-muted-foreground text-[1.0625rem] leading-relaxed">
              {SELF_HOST.description}
            </p>
            <div className="border-border mt-8 grid gap-4 border-t pt-8 sm:grid-cols-2">
              {SELF_HOST.checks.map((check) => (
                <CheckLine key={check}>{check}</CheckLine>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SELF_HOST.cards.map((card, i) => (
            <div
              key={card.name}
              className="border-border bg-background/70 flex flex-col rounded-xl border p-5 backdrop-blur-sm"
            >
              <CardGlyph variant={i} />
              <p className="text-foreground mt-6 text-[1.0625rem] font-medium">{card.name}</p>
              <p className="text-muted-foreground mt-2 text-sm leading-snug">{card.description}</p>
            </div>
          ))}
        </div>

        <div className="border-border mt-12 flex flex-col gap-6 border-t pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-sm leading-snug">
            {SELF_HOST.footerLabel.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {CLOUDS.map((cloud) => (
              <span
                key={cloud}
                className="border-border bg-background text-muted-foreground rounded-full border px-3.5 py-1.5 text-xs font-medium"
              >
                {cloud}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Isometric slab glyph — one accent, no illustration library. */
const GLYPHS = [
  { count: 4, gap: 7, size: 'size-8', spread: true },
  { count: 3, gap: 13, size: 'size-14', spread: false },
  { count: 2, gap: 26, size: 'size-16', spread: false },
  { count: 1, gap: 0, size: 'size-16', spread: false },
];

function CardGlyph({ variant }: { variant: number }) {
  const spec = GLYPHS[variant % GLYPHS.length];
  return (
    <div
      className="relative h-16 w-full"
      style={{ perspective: '600px' }}
      aria-hidden
      data-a11y-decorative
    >
      <div
        className="absolute inset-0"
        style={{ transformStyle: 'preserve-3d', transform: 'rotateX(60deg) rotateZ(-45deg)' }}
      >
        {Array.from({ length: spec.count }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'bg-kortix-blue/20 border-kortix-blue/25 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded border',
              spec.size,
            )}
            style={{
              transform: spec.spread
                ? `translate3d(${(i % 2) * 26 - 13}px, ${Math.floor(i / 2) * 26 - 13}px, 0)`
                : `translateZ(${i * spec.gap}px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
