'use client';

import { CliDemo } from '@/components/home/cli-demo';
import { InteractiveDemoSection } from '@/components/home/interactive-demo-section';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { Iso, Slab } from '@/features/marketing/v2/illustrations';
import { StackSection } from '@/features/marketing/v2/sections/stack';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import type { CSSProperties } from 'react';

/**
 * The single source of product imagery for /v2.
 *
 * Every visual on the marketing surface resolves through here, and it can only
 * resolve to something that actually exists: a real screenshot in
 * `public/images`, a real component already shipped on kortix.com, or the
 * abstract brand slabs used strictly as decoration. There is deliberately no
 * escape hatch for hand-built "screenshots" — if a section has no honest
 * visual, it passes `none` and gets nothing.
 */

/* ── the real screenshots ────────────────────────────────────────────────── */

type Shot = { alt: string; ratio: string };

/**
 * Only stills that cannot go stale live here.
 *
 * The `landing-showcase/platform/*` captures were removed deliberately: they
 * were committed on 2026-06-03 and the product has moved on since, so they
 * showed a Kortix that no longer exists. Anything depicting the product now
 * comes from the live components below, which render from current code. These
 * remaining entries are photographs and artifacts, not UI, so they stay true.
 */
const SHOTS: Record<string, Shot> = {
  /* Captured from a live project on 2026-07-29 at 2x. Retake these whenever the
     surfaces move — the previous set was two months stale and showed a product
     that no longer existed. */
  '/images/product/command-center.png': {
    alt: 'The Kortix command center: a project, its sessions, and the composer',
    ratio: '3360 / 1882',
  },
  '/images/product/skills.png': {
    alt: 'The skills library, showing a skill and the markdown file behind it',
    ratio: '3360 / 1882',
  },
  '/images/product/agents.png': { alt: 'Agents in a Kortix project', ratio: '3360 / 1882' },
  '/images/product/connectors.png': {
    alt: 'Adding a connector from the catalogue of 3,000+ apps',
    ratio: '3360 / 1882',
  },
  '/images/product/channels.png': {
    alt: 'Channels connected to a Kortix project',
    ratio: '3360 / 1882',
  },
  '/images/product/schedules.png': {
    alt: 'Scheduled triggers in a Kortix project',
    ratio: '3360 / 1882',
  },
  '/images/product/members.png': {
    alt: 'Members and roles in a Kortix project',
    ratio: '3360 / 1882',
  },
  '/images/product/marketplace.png': {
    alt: 'The Kortix marketplace: installable projects and skills',
    ratio: '3360 / 1882',
  },

  /* Artifacts and photographs — these do not depict UI, so they do not date. */
  '/images/landing-showcase/research.png': {
    alt: 'A research memo produced by a Kortix session',
    ratio: '2 / 1',
  },
  '/images/landing-showcase/data.png': {
    alt: 'A financial model produced by a Kortix session',
    ratio: '2 / 1',
  },
  '/images/landing-showcase/slides.png': {
    alt: 'A slide deck produced by a Kortix session',
    ratio: '2 / 1',
  },
  '/images/team.webp': { alt: 'The Kortix team', ratio: '16 / 9' },
  '/images/careers/shackleton.png': {
    alt: 'The Shackleton advertisement that hangs in the Kortix office',
    ratio: '295 / 171',
  },
};

/** Real components that are whole sections and must never sit inside a frame. */
const FULL_BLEED = new Set(['StackSection', 'InteractiveDemoSection']);

export type RealVisualName =
  /* screenshots — one path, or several separated by commas */
  string;

/* ── the stage ───────────────────────────────────────────────────────────── */

const STAGE: CSSProperties = {
  background:
    'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 4%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 17%, var(--background)) 100%)',
  border: '1px solid color-mix(in oklab, var(--kortix-blue) 12%, transparent)',
};

const FRAME_SHADOW =
  '0 1px 0 color-mix(in oklab, var(--foreground) 6%, transparent), 0 28px 60px -28px color-mix(in oklab, var(--kortix-blue) 55%, transparent)';

const PAD = {
  sm: 'p-3 sm:p-4',
  md: 'p-4 sm:p-6',
  lg: 'p-5 sm:p-9',
} as const;

export type VisualSize = keyof typeof PAD;

/** The soft accent-tinted plinth every framed visual sits on. */
export function VisualStage({
  children,
  size = 'md',
  className,
}: {
  children: React.ReactNode;
  size?: VisualSize;
  className?: string;
}) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-[1.6rem]', PAD[size], className)}
      style={STAGE}
    >
      {children}
    </div>
  );
}

/** One real screenshot, framed as a product shot. */
export function Screenshot({
  src,
  alt,
  ratio,
  priority,
  className,
}: {
  src: string;
  alt?: string;
  ratio?: string;
  priority?: boolean;
  className?: string;
}) {
  const shot = SHOTS[src];
  return (
    <figure
      className={cn('bg-card relative w-full overflow-hidden rounded-[1rem]', className)}
      style={{
        aspectRatio: ratio ?? shot?.ratio ?? '16 / 10',
        border: '1px solid color-mix(in oklab, var(--foreground) 9%, transparent)',
        boxShadow: FRAME_SHADOW,
      }}
    >
      <Image
        src={src}
        alt={alt ?? shot?.alt ?? ''}
        fill
        priority={priority}
        sizes="(min-width: 1024px) 60vw, 100vw"
        className="object-cover object-top"
      />
    </figure>
  );
}

/* ── the brand decoration ────────────────────────────────────────────────── */

/** Stacked frosted slabs. Decoration only — never a stand-in for the product. */
export function SlabStage({ size = 'md', className }: { size?: VisualSize; className?: string }) {
  return (
    <VisualStage size={size} className={className}>
      <div className="relative aspect-[16/11] w-full">
        <Iso className="absolute inset-0" scale={0.78}>
          {[0, 1, 2, 3].map((i) => (
            <Slab key={i} lift={i * 30} thickness={14} tone={i === 3 ? 'accent' : 'frost'} />
          ))}
        </Iso>
      </div>
    </VisualStage>
  );
}

/* ── the dispatcher ──────────────────────────────────────────────────────── */

const isPath = (name: string) => name.startsWith('/');

/** True when the visual renders its own full-width section and must not be framed. */
export function isFullBleedVisual(name?: string) {
  return !!name && FULL_BLEED.has(name.trim());
}

/** True when the section has anything to render at all. */
export function hasVisual(name?: string) {
  const key = name?.trim();
  return !!key && key !== 'none';
}

export function RealVisual({
  name,
  size = 'md',
  priority,
  className,
}: {
  name?: RealVisualName;
  size?: VisualSize;
  priority?: boolean;
  className?: string;
}) {
  const key = name?.trim();
  if (!key || key === 'none') return null;

  /* one or more real screenshots */
  if (isPath(key)) {
    const paths = key
      .split(',')
      .map((p) => p.trim())
      .filter(isPath);

    if (paths.length === 0) return null;

    if (paths.length === 1) {
      return (
        <VisualStage size={size} className={className}>
          <Screenshot src={paths[0]} priority={priority} />
        </VisualStage>
      );
    }

    // A gallery: phone shots stay narrow and centred, everything else spreads.
    const phones = paths.every((p) => p.startsWith('/images/mobile-app/'));
    return (
      <VisualStage size={size} className={className}>
        <div
          className={cn(
            'grid gap-4 sm:gap-6',
            phones
              ? 'mx-auto max-w-lg grid-cols-2'
              : paths.length === 2
                ? 'sm:grid-cols-2'
                : 'sm:grid-cols-3',
          )}
        >
          {paths.map((src, i) => (
            <Screenshot key={src} src={src} priority={priority && i === 0} />
          ))}
        </div>
      </VisualStage>
    );
  }

  switch (key) {
    /* real components that are whole sections */
    case 'StackSection':
      return <StackSection />;
    case 'InteractiveDemoSection':
      return <InteractiveDemoSection />;

    /* real components that sit inside a stage */
    case 'CliDemo':
      return (
        <VisualStage size={size} className={className}>
          <CliDemo />
        </VisualStage>
      );
    case 'KortixGrid':
      return (
        <div
          aria-hidden
          data-a11y-decorative
          className={cn(
            'pointer-events-none mask-y-from-75% mask-x-from-75% [&>div]:h-full',
            className,
          )}
        >
          <KortixGrid
            count={58}
            seed={4228}
            gradient="linear-gradient(to top left, var(--kortix-blue), color-mix(in oklab, var(--kortix-blue) 35%, var(--foreground)), var(--kortix-blue))"
          />
        </div>
      );
    case 'KortixLetterField':
      return (
        <div aria-hidden data-a11y-decorative className={className}>
          <KortixLetterField />
        </div>
      );

    /* abstract brand decoration */
    case 'slabs':
      return <SlabStage size={size} className={className} />;
  }

  // Unknown identifier: render nothing rather than invent something.
  return null;
}
