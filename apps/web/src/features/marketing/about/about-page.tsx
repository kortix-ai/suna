'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { Github } from '@/features/icon/icons/github';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { closing, hero, platform, statements } from './content';

/* Prose sits on a ~65–70 character measure. The grid is 6xl; body copy never
   runs its full width. */
const MEASURE = 'max-w-[34rem]';

/* The closing card is deliberately dark in BOTH themes — the same treatment as
   `features/marketing/landing/trust-section.tsx` — so nothing inside it reads a
   theme token. */
const INK = '#0a0a0a';

function Eyebrow({ children }: { children: string }): ReactNode {
  return (
    <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
      {children}
    </p>
  );
}

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
    <section className="pt-20 pb-14 sm:pb-20">
      <Reveal>
        <div className="relative aspect-[2/1] w-full overflow-hidden lg:aspect-[21/9]">
          <Image
            src="/images/team.webp"
            alt={hero.imageAlt}
            fill
            priority
            className="object-cover object-bottom"
            sizes="100vw"
          />
        </div>

        <div className="mx-auto max-w-7xl px-6">
          <div className="mt-14 sm:mt-16">
            <Eyebrow>{hero.eyebrow}</Eyebrow>
          </div>

          <h1 className="text-foreground mt-8 max-w-4xl text-4xl leading-[1.02] font-medium tracking-tight text-balance sm:text-6xl lg:text-7xl">
            {hero.title}
          </h1>

          <p
            className={cn(MEASURE, 'text-muted-foreground mt-8 text-lg leading-relaxed sm:text-xl')}
          >
            {hero.lead}
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Button size="sm" asChild>
              <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={hero.ctaSecondaryHref} target="_blank" rel="noreferrer">
                <Github className="size-4" />
                {hero.ctaSecondary}
              </a>
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
                  <p className="text-muted-foreground font-mono text-[10px] tracking-widest">
                    {statement.n}
                  </p>
                  <h2 className="text-foreground mt-4 text-2xl leading-tight font-medium tracking-tight text-balance sm:text-3xl">
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

/**
 * The six verbs, as a table rather than six cards — the shape of the platform.
 * There is no status column and no dimmed row: the tense in `content.ts` marks
 * what is real today and what is direction. See the accuracy gate there before
 * editing a row.
 */
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

function Closing(): ReactNode {
  return (
    <section id="closing" className="mx-auto max-w-7xl px-6 pt-8 pb-16 sm:pb-24">
      <Reveal>
        <div
          className="rounded-xl border border-white/10 px-6 py-14 sm:px-12 sm:py-20"
          style={{ backgroundColor: INK }}
        >
          <h2 className="max-w-3xl text-3xl leading-[1.1] font-medium tracking-tight text-balance text-white sm:text-5xl">
            {closing.title}
          </h2>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Button size="sm" asChild className="bg-white text-[#0a0a0a] hover:bg-white/90">
              <Link href={closing.ctaPrimaryHref}>{closing.ctaPrimary}</Link>
            </Button>
            <Button
              size="sm"
              asChild
              className="border border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              <a href={closing.ctaSecondaryHref} target="_blank" rel="noreferrer">
                <Github className="size-4" />
                {closing.ctaSecondary}
              </a>
            </Button>
          </div>
        </div>
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
      <Closing />
    </main>
  );
}
