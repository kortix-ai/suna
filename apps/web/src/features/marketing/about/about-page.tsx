'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { ArrowRightIcon } from '@/features/icon/arrow-right';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { hero, platform, statements } from './content';

/* Prose sits on a ~65–70 character measure. The grid is 6xl; body copy never
   runs its full width. */
const MEASURE = 'max-w-[34rem]';

/**
 * The team, then the thesis. The photograph opens the page edge to edge — it is
 * the six people making the argument, so it gets the full viewport rather than
 * the 6xl measure everything else hangs on.
 *
 * The crop is the whole point. `/images/team.webp` is 1920×1080 with roughly a
 * quarter of its height empty above the heads, so the band is wider than the
 * source at every width and `object-bottom` takes the whole crop off the top —
 * dead space out, the six figures whole, shoes to hair. `object-cover` scales to
 * the container WIDTH, so cropping the top costs nothing in how large the people
 * render; it only removes emptiness. 21:9 is the tightest the band can go, and
 * full-bleed spends the remaining margin: at 1440px it crops 193px of a 211px
 * void. Widen the ratio further and the crop line reaches the tallest head.
 */
function Hero(): ReactNode {
  return (
    <section className="mx-auto max-w-7xl px-6 pt-28 pb-14 sm:pt-36 sm:pb-28">
      <Reveal>
        <div className="relative aspect-[2/1] w-full overflow-hidden rounded-sm border lg:aspect-[21/9]">
          <Image
            src="/images/team.webp"
            alt={hero.imageAlt}
            fill
            priority
            className="object-cover object-bottom"
            sizes="100vw"
          />
        </div>

        <div className="mt-14 flex w-full flex-col items-start gap-6 sm:mt-16">
          <span
            className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none"
            data-text="true"
          >
            {hero.eyebrow}
          </span>
          <h1 className="text-foreground max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            {hero.title}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-lg leading-relaxed">{hero.lead}</p>

          <div className="kx-hero-text flex w-full shrink-0 flex-wrap items-center gap-2 [--kx-enter:210ms] sm:w-auto sm:gap-3">
            <Button size="lg" className="flex-1 active:scale-[0.97] sm:flex-none" asChild>
              <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="group/arrow-right flex-1 gap-1.5 active:scale-[0.97] sm:flex-none"
              asChild
            >
              <Link href={hero.ctaSecondaryHref} target="_blank" rel="noreferrer">
                {hero.ctaSecondary}
                <ArrowRightIcon aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/** The three claims. Mono index, headline, one paragraph, a rule between each. */
function Statements(): ReactNode {
  return (
    <section id="thesis" className="mx-auto max-w-7xl px-6">
      <ol>
        {statements.map((statement) => (
          <li key={statement.id} className="border-border border-t">
            <Reveal>
              <div className="grid gap-6 py-12 sm:py-16 lg:grid-cols-12 lg:gap-16">
                <div className="lg:col-span-6">
                  <span
                    className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none"
                    data-text="true"
                  >
                    {statement.n}
                  </span>
                  <h2 className="text-foreground mt-4 max-w-xl text-2xl leading-tight font-medium tracking-tight text-balance sm:text-3xl">
                    {statement.title}
                  </h2>
                </div>
                <p
                  className={cn(
                    MEASURE,
                    'text-muted-foreground text-base leading-relaxed lg:col-span-6 lg:pt-8',
                  )}
                >
                  {statement.body}
                </p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PlatformSection(): ReactNode {
  return (
    <section id="platform" className="mx-auto max-w-7xl px-6 py-24 sm:py-30">
      <SectionHeader eyebrow={platform.eyebrow} title={platform.title} />
      <Reveal>
        <p className={cn(MEASURE, 'text-muted-foreground mt-5 text-base leading-relaxed')}>
          {platform.sub}
        </p>

        <ul className="border-border mt-12 border-b">
          {platform.items.map((item) => (
            <li
              key={item.id}
              className="border-border grid gap-2 border-t py-6 lg:grid-cols-12 lg:items-baseline lg:gap-10"
            >
              {/* 6/6, the same split the statements above use, so both sections
                  hang their body copy off one vertical axis. */}
              <h3 className="text-foreground text-xl font-medium tracking-tight lg:col-span-6">
                {item.verb}
              </h3>

              <p
                className={cn(
                  MEASURE,
                  'text-muted-foreground text-base leading-relaxed lg:col-span-6',
                )}
              >
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}

/**
 * `/about` — why Kortix exists, in the founder's framing.
 *
 * The team opens the page, then the thesis at the largest type on the site.
 * Everything after it is support: three claims, the six-verb platform table,
 * and one close. Copy and the accuracy gate live in `content.ts`.
 */
export function AboutPage(): ReactNode {
  return (
    <main className="bg-background min-h-screen">
      <Hero />
      <Statements />
      <PlatformSection />
    </main>
  );
}
