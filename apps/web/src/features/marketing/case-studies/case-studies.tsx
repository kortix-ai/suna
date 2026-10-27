'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { cn } from '@kortix/ui';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BriefcaseIcon,
  CellTowerIcon,
  ChartLineUpIcon,
  CheckIcon,
} from '@phosphor-icons/react/dist/ssr';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { caseStudies, type CaseStudy } from './content';

const ICONS = { telecom: CellTowerIcon, search: BriefcaseIcon, finance: ChartLineUpIcon } as const;

const PLATINUM_TRACKING = 'tracking-[0.22em]'; // audit:allow Platinum's own wordmark tracking (pt-logo.tsx), a third-party mark

/** Platinum's mark as platinum.dev draws it (`pt-logo.tsx`): a square and PLATINUM in mono, both currentColor. */
function PlatinumMark() {
  return (
    <span
      className="text-foreground inline-flex items-center gap-4"
      role="img"
      aria-label="Platinum"
    >
      <span aria-hidden className="block size-5 bg-current" />
      <span aria-hidden className={`font-mono text-xl ${PLATINUM_TRACKING}`}>
        PLATINUM
      </span>
    </span>
  );
}

/** A third-party logo is drawn for a white ground: white in both themes (color.md, logo tile rule). */
const LOGO_TILE_BACKGROUND = 'bg-white';

/** The card's top: the logo on its white tile, or the glyph on the muted ground. */
function Mark({ item }: { item: CaseStudy }) {
  if (item.logo) {
    return (
      <div
        className={`${LOGO_TILE_BACKGROUND} flex h-40 items-center justify-center rounded-md border`}
      >
        <Image
          src={item.logo.src}
          alt={item.logo.alt}
          width={item.logo.width}
          height={item.logo.height}
          unoptimized
          // A wordmark (wider than 2.5:1) sits lower so it matches a stacked mark's weight.
          className={item.logo.width / item.logo.height > 2.5 ? 'h-12 w-auto' : 'h-24 w-auto'}
        />
      </div>
    );
  }
  const Icon = ICONS[item.icon ?? 'search'];
  return (
    <div className="bg-muted flex h-40 items-center justify-center rounded-md">
      {item.mark === 'kortix' ? (
        <KortixLogo size={28} variant="logomark" />
      ) : item.mark === 'platinum' ? (
        <PlatinumMark />
      ) : (
        <Icon className="text-foreground size-12" aria-hidden />
      )}
    </div>
  );
}

/** One case study: its mark, who, the title, the story and four facts. */
function CaseStudyCard({ item, className }: { item: CaseStudy; className?: string }) {
  return (
    <li
      id={item.id}
      className={cn('bg-background flex scroll-mt-20 flex-col gap-5 p-6 lg:p-11', className)}
    >
      <Mark item={item} />
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">{item.category}</p>
        <p className="text-foreground text-sm font-medium">{item.org}</p>
      </div>
      <h3 className="text-foreground text-xl font-medium tracking-tight text-balance">
        {item.title}
      </h3>
      <p className="text-muted-foreground text-base text-pretty">{item.body}</p>
      <ul className="mt-auto grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {item.facts.map((fact) => (
          <li key={fact} className="text-foreground flex items-start gap-2">
            <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {fact}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Every case study as a two-column grid: the /case-studies page. */
export function CaseStudyGrid() {
  return (
    <Band>
      <ul className="bg-border grid grid-cols-1 gap-px lg:grid-cols-2">
        {caseStudies.items.map((item) => (
          <CaseStudyCard key={item.id} item={item} />
        ))}
      </ul>
    </Band>
  );
}

/**
 * Case studies as one horizontal row: cards snap into place, the arrows move
 * one card, and the row scrolls by touch, trackpad or keyboard too. Nothing
 * here links anywhere, on purpose. Copy and the naming rules: `./content.ts`.
 */
export function CaseStudies({ id = 'case-studies', allLink = false }: { id?: string; allLink?: boolean }) {
  const row = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });

  function measure() {
    const el = row.current;
    if (!el) return;
    setEdge({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }
  useEffect(measure, []);

  function step(direction: 1 | -1) {
    const el = row.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (!el || !card) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The 1px is the hairline gap between cards.
    el.scrollBy({ left: direction * (card.offsetWidth + 1), behavior: reduce ? 'auto' : 'smooth' });
  }

  return (
    <section id={id} className="scroll-mt-16 py-14 lg:py-20">
      <Heading
        title={caseStudies.title}
        titleMuted={caseStudies.titleMuted}
        actions={
          <>
            <MarketingButton
              variant="secondary"
              size="md"
              className="w-10 px-0"
              aria-label="Previous case study"
              disabled={edge.start}
              onClick={() => step(-1)}
            >
              <ArrowLeftIcon aria-hidden />
            </MarketingButton>
            <MarketingButton
              variant="secondary"
              size="md"
              className="w-10 px-0"
              aria-label="Next case study"
              disabled={edge.end}
              onClick={() => step(1)}
            >
              <ArrowRightIcon aria-hidden />
            </MarketingButton>
            {allLink ? (
              <MarketingButton variant="secondary" size="md" asChild>
                <Link href="/case-studies">All case studies</Link>
              </MarketingButton>
            ) : null}
          </>
        }
      />
      <Band className="mt-12">
        <ul
          ref={row}
          onScroll={measure}
          tabIndex={0}
          aria-label="Case studies"
          className="bg-border scrollbar-hide outline-ring flex snap-x snap-mandatory gap-px overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {caseStudies.items.map((item) => (
            <CaseStudyCard
              key={item.id}
              item={item}
              className="w-4/5 shrink-0 snap-start sm:w-3/5 lg:w-2/5"
            />
          ))}
        </ul>
      </Band>
    </section>
  );
}
