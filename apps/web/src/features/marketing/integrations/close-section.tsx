'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import Link from 'next/link';
import { close } from './content';
import { Section } from './shared';

/** Closing card. Same shape as the enterprise page close, so the two pages end alike. */
export function CloseSection() {
  return (
    <Section id="cta">
      <Reveal>
        <div className="border-border bg-card relative overflow-hidden rounded-sm border">
          <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
            <div className="col-span-5 flex flex-col items-start justify-start gap-6 p-6 sm:p-8">
              <div>
                <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight text-balance sm:text-3xl">
                  {close.title}
                </h2>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{close.sub}</p>
              </div>

              <ul className="space-y-3">
                {close.points.map((point, i) => (
                  <li
                    key={point}
                    className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                  >
                    <KortixAsterisk index={i} />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                <Button size="lg" className="w-full" asChild>
                  <Link href="/auth">{close.ctaPrimary}</Link>
                </Button>
                <Button size="lg" variant="accent" className="w-full" asChild>
                  <Link href={close.ctaSecondaryHref}>{close.ctaSecondary}</Link>
                </Button>
              </div>
            </div>
            <div className="col-span-7 mask-y-from-90% mask-x-from-90%">
              <KortixGrid count={58} seed={7211} />
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
