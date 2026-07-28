'use client';

import { Button } from '@/components/ui/marketing/button';
import { OPEN } from '@/features/marketing/v2/content';
import { SlabMark } from '@/features/marketing/v2/illustrations';
import {
  CheckLine,
  Eyebrow,
  Heading,
  Lead,
  Section,
} from '@/features/marketing/v2/primitives';
import Link from 'next/link';

/** Open, and yours — self-host, VPC, on-prem, air-gapped. */
export function OpenSection() {
  return (
    <Section id="open" className="bg-muted/40 border-border border-y">
      <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <Eyebrow>{OPEN.eyebrow}</Eyebrow>
          <Heading lines={OPEN.heading} className="mt-6" />
          <Button size="lg" asChild className="mt-8 w-fit">
            <Link href="/enterprise">Explore self-hosted</Link>
          </Button>
        </div>

        <div>
          <Lead>{OPEN.description}</Lead>
          <div className="border-border mt-8 grid gap-4 border-t pt-8 sm:grid-cols-2">
            {OPEN.checks.map((check) => (
              <CheckLine key={check}>{check}</CheckLine>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {OPEN.cards.map((card, i) => (
          <div
            key={card.name}
            className="border-border bg-background overflow-hidden rounded-sm border"
          >
            <div
              className="border-border border-b py-4"
              style={{
                background:
                  'radial-gradient(110% 90% at 50% 0%, color-mix(in oklab, var(--kortix-blue) 9%, var(--background)) 0%, var(--background) 70%)',
              }}
            >
              <SlabMark count={(i % 3) + 1} tone={i === 1 ? 'accent' : 'frost'} />
            </div>
            <div className="p-5">
              <p className="text-foreground text-base font-medium">{card.name}</p>
              <p className="text-muted-foreground mt-2 text-sm leading-snug">{card.description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="border-border mt-12 flex flex-col gap-6 border-t pt-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground text-sm leading-snug">
          {OPEN.footerLabel.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {OPEN.clouds.map((cloud) => (
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
