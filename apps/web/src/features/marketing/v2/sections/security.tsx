'use client';

import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { SECURITY } from '@/features/marketing/v2/content';
import { CheckLine, Heading, Lead } from '@/features/marketing/v2/primitives';
import Link from 'next/link';

export function SecuritySection() {
  return (
    <section
      id="security"
      className="bg-foreground text-background relative scroll-mt-24 overflow-hidden"
    >
      <div
        className="pointer-events-none absolute inset-0 z-0 mask-y-from-10% opacity-25"
        aria-hidden
        data-a11y-decorative
      >
        <KortixLetterField seed={4228} className="invert dark:invert-0" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-6 py-16 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
          <div>
            <span className="border-background/25 text-background/80 inline-block rounded border px-2 py-0.5 text-xs font-medium">
              {SECURITY.eyebrow}
            </span>
            <Heading lines={SECURITY.heading} tone="inverse" className="mt-6" />
            <Lead tone="inverse" className="mt-5">
              {SECURITY.subheading}
            </Lead>
            <Button size="lg" variant="inverse" asChild className="mt-8 w-fit">
              <Link href="/enterprise">{SECURITY.cta}</Link>
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:justify-items-end">
            {SECURITY.badges.map((badge) => (
              <div
                key={badge}
                className="border-background/20 bg-background/[0.07] text-background/85 flex aspect-square items-center justify-center rounded-sm border p-3 text-center text-xs leading-tight font-medium"
              >
                {badge}
              </div>
            ))}
          </div>
        </div>

        <div className="border-background/15 mt-16 grid gap-8 border-t pt-10 md:grid-cols-3 md:gap-10">
          {SECURITY.points.map((point) => (
            <div key={point.name}>
              <CheckLine tone="inverse">
                <span className="font-medium">{point.name}</span>
              </CheckLine>
              <p className="text-background/60 mt-2 pl-[1.625rem] text-sm leading-relaxed">
                {point.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
