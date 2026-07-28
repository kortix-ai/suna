'use client';

import { Button } from '@/components/ui/marketing/button';
import { SELF_HOST } from '@/features/marketing/v2/content';
import { CheckLine, Heading, Lead, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import Link from 'next/link';

const CLOUDS = ['AWS', 'Google Cloud', 'Azure', 'On premise'];

export function SelfHostSection() {
  return (
    <Section id="self-host" className="bg-muted/40 border-border border-y">
      <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <Heading lines={SELF_HOST.heading} />
          <Button size="lg" asChild className="mt-8 w-fit">
            <Link href="/enterprise">{SELF_HOST.cta}</Link>
          </Button>
        </div>

        <div>
          <Lead>{SELF_HOST.description}</Lead>
          <div className="border-border mt-8 grid gap-4 border-t pt-8 sm:grid-cols-2">
            {SELF_HOST.checks.map((check) => (
              <CheckLine key={check}>{check}</CheckLine>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SELF_HOST.cards.map((card, i) => (
          <div key={card.name} className="border-border bg-background rounded-sm border p-5">
            <CardGlyph variant={i} />
            <p className="text-foreground mt-6 text-base font-medium">{card.name}</p>
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
              className="border-border bg-background text-muted-foreground rounded-sm border px-3.5 py-1.5 text-xs font-medium"
            >
              {cloud}
            </span>
          ))}
        </div>
      </div>
    </Section>
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
              'bg-kortix-blue/15 border-kortix-blue/35 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm border',
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
