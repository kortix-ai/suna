'use client';

import { Hero } from '@/features/marketing/v2/hero';
import { Iso, Slab } from '@/features/marketing/v2/illustrations';
import {
  CtaSection,
  type SectionSpec,
  ShowcaseSection,
  SplitSection,
} from '@/features/marketing/v2/page-kit';
import { LANDING } from '@/features/marketing/v2/pages-content';
import {
  CheckLine,
  Display,
  InvertedPanel,
  Lead,
  LedeBullet,
  MAX_W,
  Section,
} from '@/features/marketing/v2/primitives';
import { RealVisual, Screenshot, VisualStage } from '@/features/marketing/v2/real-visual';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The landing page.
 *
 * Copy is owned by `LANDING` in pages-content.ts and pulled in by section id, so
 * this file only decides shape: which section renders each beat, which side its
 * visual sits on, and where a tinted band breaks the page up. Five beats are
 * composed here rather than taken from the kit — see each one for why.
 */

type Copy = {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  visual?: string;
};

/**
 * Pulls one section's copy out of `LANDING`, keeping this file free of prose.
 * `anchor: false` drops the id for the one beat whose visual is itself a
 * section that already carries the anchor.
 */
function copy(id: string, { anchor = true }: { anchor?: boolean } = {}): Copy {
  const found: SectionSpec | undefined = LANDING.find((section) => section.id === id);
  if (!found) throw new Error(`Landing copy is missing the "${id}" section`);
  return {
    id: anchor ? found.id : undefined,
    heading: found.heading,
    body: found.body,
    bullets: found.bullets,
    visual: found.visual,
  };
}

/**
 * "Lede. The rest." or "Term — the rest." The kit's splitter checks the dash
 * first, which mis-titles the two landing bullets whose first sentence contains
 * one: it cuts "Change request." off at the dash further down the line, and
 * splits "SOC 2 Type II — in progress." into a bare "SOC 2 Type II" that reads
 * as a certification Kortix has not earned. Here a sentence boundary wins and
 * the dash is only a fallback.
 */
function splitLede(text: string): { lede: string; rest?: string } {
  const sentence = text.match(/^(.{1,70}?[.?!])\s+(\S[\s\S]*)$/);
  if (sentence) return { lede: sentence[1], rest: sentence[2] };
  const dash = text.indexOf(' — ');
  if (dash > 0 && dash <= 70) return { lede: text.slice(0, dash), rest: text.slice(dash + 3) };
  return { lede: text };
}

/** Strips the trailing period a lede carries so it can be used as a title. */
const asTitle = (lede: string) => lede.replace(/[.:]$/, '');

/* ── locally composed beats ──────────────────────────────────────────────── */

/**
 * A split whose visual is supplied as a node. `SplitSection` covers most beats,
 * but this one adds `min-w-0` to the grid cells — `CliDemo` sizes itself from a
 * fixed height and an aspect ratio, so a cell left at the grid default of
 * `min-width: auto` inherits its 853px min-content width and scrolls the page
 * sideways on a phone.
 */
function Feature({
  section,
  visual,
  reversed,
  tone = 'plain',
}: {
  section: Copy;
  visual: ReactNode;
  reversed?: boolean;
  tone?: 'plain' | 'muted';
}) {
  return (
    <Section id={section.id} tone={tone}>
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div className={cn('min-w-0', reversed && 'lg:order-2')}>
          <Display lines={section.heading} />
          {section.body && <Lead className="mt-6">{section.body}</Lead>}
          {section.bullets && (
            <div className="mt-8">
              {section.bullets.map((bullet) => {
                const { lede, rest } = splitLede(bullet);
                return <LedeBullet key={bullet} lede={lede} rest={rest} />;
              })}
            </div>
          )}
        </div>
        <div className={cn('min-w-0', reversed && 'lg:order-1')}>{visual}</div>
      </div>
    </Section>
  );
}

/** The ask → session → change request → merge rail: the spine of the page. */
function Steps({ section }: { section: Copy }) {
  return (
    <Section id={section.id} tone="muted">
      <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div>
          <Display lines={section.heading} />
          {section.body && <Lead className="mt-6">{section.body}</Lead>}
        </div>
        <ol>
          {section.bullets?.map((bullet, i) => {
            const { lede, rest } = splitLede(bullet);
            return (
              <li key={bullet} className="border-border border-t py-6">
                <p className="text-foreground flex items-baseline gap-2.5 text-[1.0625rem] font-medium">
                  <span className="text-muted-foreground/60 font-mono text-xs tabular-nums">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {asTitle(lede)}
                </p>
                {rest && (
                  <p className="text-muted-foreground mt-2 pl-[1.9rem] text-[0.9375rem] leading-[1.6]">
                    {rest}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}

/** Slab positions for the session field, in the isometric plane. */
const FIELD = [-92, 0, 92].flatMap((x, col) =>
  [-92, 0, 92].map((y, row) => ({
    x,
    y,
    // a little independent height, so the runs read as concurrent rather than stacked
    lift: ((col * 3 + row) % 4) * 9,
    accent: (col + row) % 4 === 1,
  })),
);

/**
 * Many small slabs on one plane — the workforce: every session its own machine,
 * all of them on the same config. Brand decoration, not a depiction of the UI.
 */
function SessionField() {
  return (
    <VisualStage>
      <div className="relative aspect-[16/11] w-full">
        <Iso className="absolute inset-0" scale={0.82}>
          {FIELD.map((cell) => (
            <div
              key={`${cell.x}:${cell.y}`}
              className="absolute top-0 left-0"
              style={{
                transformStyle: 'preserve-3d',
                transform: `translate3d(${cell.x}px, ${cell.y}px, 0)`,
              }}
            >
              <Slab
                size={74}
                thickness={11}
                lift={cell.lift}
                tone={cell.accent ? 'accent' : 'frost'}
              />
            </div>
          ))}
        </Iso>
      </div>
    </VisualStage>
  );
}

/** The three real deliverables, in the order the section body names them. */
const DELIVERABLES = [
  { src: '/images/landing-showcase/research.png', label: 'Research memo' },
  { src: '/images/landing-showcase/data.png', label: 'Financial model' },
  { src: '/images/landing-showcase/slides.png', label: 'Slide deck' },
];

/** Centred copy over the real artifacts, each one labelled with what it is. */
function Deliverables({ section }: { section: Copy }) {
  return (
    <section id={section.id} className="scroll-mt-24 py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="mx-auto max-w-2xl text-center">
          <Display lines={section.heading} />
          {section.body && <Lead className="mt-6">{section.body}</Lead>}
        </div>

        <div className="mt-14">
          <VisualStage size="lg">
            <div className="grid gap-6 sm:grid-cols-3">
              {DELIVERABLES.map((item) => (
                <div key={item.src}>
                  <Screenshot src={item.src} />
                  <p className="text-muted-foreground mt-3 text-center text-[0.8125rem]">
                    {item.label}
                  </p>
                </div>
              ))}
            </div>
          </VisualStage>
        </div>
      </div>
    </section>
  );
}

/** The trust panel. Local so the SOC 2 line keeps its "— in progress" qualifier. */
function TrustPanel({ section }: { section: Copy }) {
  return (
    <InvertedPanel id={section.id}>
      <div className="px-8 pt-14 pb-14 sm:px-14 sm:pt-16">
        <div className="grid gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <Display lines={section.heading} tone="inverse" />
          {section.body && (
            <div className="lg:pt-2">
              <Lead tone="inverse">{section.body}</Lead>
            </div>
          )}
        </div>

        <div className="border-background/15 mt-14 grid gap-x-12 gap-y-2 border-t pt-6 md:grid-cols-2">
          {section.bullets?.map((bullet) => {
            const { lede, rest } = splitLede(bullet);
            return (
              <div key={bullet} className="border-background/10 border-b py-6 last:border-b-0">
                <CheckLine tone="inverse">
                  <span className="font-medium">{asTitle(lede)}</span>
                </CheckLine>
                {rest && (
                  <p className="text-background/60 mt-2.5 pl-[1.75rem] text-[0.9375rem] leading-[1.55]">
                    {rest}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </InvertedPanel>
  );
}

/**
 * The ownership close: the argument across the top, the four guarantees wide
 * underneath. It carries no visual on purpose — an abstract slab here would be
 * the third on the page and would say nothing the four lines do not.
 */
function Ownership({ section }: { section: Copy }) {
  return (
    <Section id={section.id}>
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
        {/* balancing this heading breaks "Self-hostable" across two lines */}
        <Display lines={section.heading} className="text-pretty" />
        {section.body && (
          <div className="lg:pt-2">
            <Lead>{section.body}</Lead>
          </div>
        )}
      </div>

      <div className="mt-12 grid gap-x-14 md:grid-cols-2">
        {section.bullets?.map((bullet) => {
          const { lede, rest } = splitLede(bullet);
          return <LedeBullet key={bullet} lede={lede} rest={rest} />;
        })}
      </div>
    </Section>
  );
}

/* ── the page ────────────────────────────────────────────────────────────── */

export default function MarketingV2Page() {
  const cli = copy('cli');

  return (
    <main className="bg-background">
      {/* the hero is the blue field, so it is not part of the section list */}
      <Hero />

      {/* what it is — StackSection carries id="stack" itself, so the intro must not */}
      <ShowcaseSection {...copy('stack', { anchor: false })} />
      <SplitSection {...copy('company-as-code')} />

      {/* how it works */}
      <Steps section={copy('how-work-lands')} />
      <Feature section={copy('workforce')} visual={<SessionField />} reversed />

      {/* proof */}
      <Deliverables section={copy('deliverables')} />
      <SplitSection {...copy('skills-and-memory')} tone="muted" />
      <SplitSection {...copy('channels')} reversed />
      <Feature section={cli} tone="muted" visual={<RealVisual name={cli.visual} />} />

      {/* trust */}
      <TrustPanel section={copy('security')} />

      {/* act */}
      <Ownership section={copy('open')} />
      <CtaSection {...copy('closing-cta')} />
    </main>
  );
}
