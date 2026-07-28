'use client';

import { Button } from '@/components/ui/marketing/button';
import { LIBRARY } from '@/features/marketing/v2/content';
import { SlabMark } from '@/features/marketing/v2/illustrations';
import { Eyebrow, Heading, Lead, Section } from '@/features/marketing/v2/primitives';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

/** Agents, skills, connectors — the installable building blocks. */
export function LibrarySection() {
  return (
    <Section id="library" className="bg-muted/40 border-border border-y">
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{LIBRARY.eyebrow}</Eyebrow>
        <Heading lines={LIBRARY.heading} className="mt-6" />
        <Lead className="mt-5">{LIBRARY.subheading}</Lead>
      </div>

      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {LIBRARY.cards.map((card, i) => (
          <article
            key={card.title}
            className="border-border bg-background flex flex-col overflow-hidden rounded-sm border"
          >
            <div
              className="border-border border-b py-6"
              style={{
                background:
                  'radial-gradient(110% 90% at 50% 0%, color-mix(in oklab, var(--kortix-blue) 10%, var(--background)) 0%, var(--background) 70%)',
              }}
            >
              <SlabMark count={i + 2} tone="accent" />
            </div>
            <div className="flex flex-1 flex-col p-5">
              <h3 className="text-foreground text-lg font-medium">{card.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{card.body}</p>
              <div className="mt-5 flex flex-wrap gap-1.5">
                {card.items.map((item) => (
                  <span
                    key={item}
                    className="border-border bg-card text-muted-foreground rounded-sm border px-2 py-0.5 font-mono text-[11px]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-10 text-center">
        <Button variant="secondary" size="lg" asChild className="w-fit">
          <Link href="/marketplace">
            Browse the marketplace
            <ChevronRight className="size-3.5" />
          </Link>
        </Button>
      </div>
    </Section>
  );
}
