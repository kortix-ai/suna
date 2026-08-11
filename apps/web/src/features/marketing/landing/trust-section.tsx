'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { ShaderSafe } from '@/components/ui/shader-safe';
import { cn } from '@/lib/utils';
import { Heatmap } from '@paper-design/shaders-react';
import { CheckIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { trust } from './content';

/* The card is deliberately dark in BOTH themes, so nothing inside it may read a
   theme token. Every surface, border and text colour here is a fixed value. */
const INK = '#0a0a0a';

/**
 * The animated metallic dosco mark, reused from the enterprise/security
 * section (`features/marketing/security/security.tsx`): the Paper Shaders
 * `Heatmap` running over `/shaders/heatmap-mark.svg`. Here it is large,
 * off-centre and low-opacity — texture behind the card, never a focal point.
 * `ShaderSafe` degrades it to nothing on GPUs without working WebGL2.
 */
function MetallicMark() {
  return (
    <div
      aria-hidden
      /* Anchored to the card's own height rather than hung off a fixed pixel
         size. It used to be 760x900 pinned at -top-32/-right-40, so the card's
         overflow-hidden sliced the mark's upper arcs clean off and the box
         never closed at the top. inset-y-0 makes the mark exactly as tall as
         the card, whatever the copy does to it. */
      className="pointer-events-none absolute inset-y-0 right-0 hidden aspect-[900/760] opacity-[0.42] mix-blend-screen select-none sm:block"
    >
      <ShaderSafe>
        <Heatmap
          speed={1}
          contour={0.5}
          angle={0}
          noise={0}
          innerGlow={0.5}
          outerGlow={0.05}
          scale={0.8}
          image="/shaders/heatmap-mark.svg"
          frame={407072.499999992}
          colors={['#d18b19', '#fafafa', '#242424']}
          colorBack="#ffffff00"
          className="h-full w-full"
          style={{ height: '100%', width: '100%' }}
        />
      </ShaderSafe>
    </div>
  );
}

/**
 * One compliance badge, drawn as a shield.
 *
 * ACCURACY GATE: dosco holds none of these. The shield is stroked and dimmed
 * well below the surrounding text, and carries the "In progress" state inline,
 * so the badge cannot be read as a claim on its own — in a screenshot, a crop,
 * or a screen reader.
 */
function ShieldBadge({ line1, line2, state }: { line1: string; line2: string; state: string }) {
  return (
    <li className="relative flex w-[132px] shrink-0 flex-col items-center">
      <svg
        viewBox="0 0 100 116"
        className="w-full text-white/40"
        role="img"
        aria-label={`${line1}${line2 ? ` ${line2}` : ''}${state ? ` — ${state}` : ''}`}
      >
        <title>{`${line1}${line2 ? ` ${line2}` : ''}${state ? ` — ${state}` : ''}`}</title>
        <path
          d="M50 4 L94 18 V60 C94 88 74 104.5 50 112 C26 104.5 6 88 6 60 V18 Z"
          fill="currentColor"
          fillOpacity={0.10}
          stroke="currentColor"
          strokeWidth={1.5}
        />
        <path d="M22 74 H78" stroke="currentColor" strokeWidth={1} strokeOpacity={0.5} />
      </svg>

      <span className="pointer-events-none absolute inset-x-0 top-0 flex h-[calc(74/116*100%)] flex-col items-center justify-center gap-0.5 px-2">
        <span className="font-mono text-[15px] leading-none font-medium tracking-wider text-white/85">
          {line1}
        </span>
        {line2 ? (
          <span className="font-mono text-[13px] leading-none tracking-wider text-white/65">
            {line2}
          </span>
        ) : null}
      </span>

      <span className="pointer-events-none absolute inset-x-0 top-[calc(74/116*100%)] flex h-[calc(38/116*100%)] items-start justify-center pt-1.5">
        {state ? (
          <span className="font-mono text-[10px] leading-none tracking-wide text-white/50 uppercase">
            {state}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function TrustColumn({
  title,
  body,
  className,
}: {
  title: string;
  body: string;
  className?: string;
}) {
  return (
    <div className={cn('px-6 py-8 sm:px-8 sm:py-10', className)}>
      <span
        aria-hidden
        className="flex size-5 items-center justify-center rounded-sm bg-white/10 text-white/70"
      >
        <CheckIcon className="size-3" weight="bold" />
      </span>
      <h3 className="mt-4 text-base font-medium tracking-tight text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-white/55">{body}</p>
    </div>
  );
}

/**
 * The closing section: what makes the platform trustworthy, and exactly where
 * we stand on certification. Tembo runs the same shape (one dark card, badges,
 * three pillars); the honest half is ours — the badge row states plainly that
 * nothing is certified yet.
 */
export function TrustSection(): ReactNode {
  return (
    <section id="trust" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
      <Reveal>
        <div
          className="relative isolate overflow-hidden rounded-xl border border-white/10"
          style={{ backgroundColor: INK }}
        >
          <MetallicMark />

          {/* upper: headline + CTA on the left, badge shields on the right */}
          <div className="relative grid gap-10 px-6 py-12 sm:px-8 sm:py-14 lg:grid-cols-12 lg:gap-12 lg:px-10">
            <div className="lg:col-span-7">
              <p className="font-mono text-[10px] tracking-widest text-white/40 uppercase">
                {trust.eyebrow}
              </p>

              <h2 className="mt-5 text-3xl leading-[1.12] font-medium tracking-tight text-white sm:text-4xl lg:text-[2.75rem]">
                {trust.titleLines.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </h2>

              <p className="mt-5 max-w-md text-base leading-relaxed text-white/55">{trust.sub}</p>

              <Button
                size="sm"
                asChild
                className="mt-8 w-fit bg-white text-[#0a0a0a] hover:bg-white/90"
              >
                <Link href={trust.ctaHref}>{trust.ctaLabel}</Link>
              </Button>
            </div>

            <div className="lg:col-span-5 lg:justify-self-end">
              <ul className="flex flex-wrap items-start gap-4 sm:gap-5">
                {trust.badges.map((badge) => (
                  <ShieldBadge
                    key={badge.id}
                    line1={badge.line1}
                    line2={badge.line2}
                    state={badge.state}
                  />
                ))}
              </ul>
            </div>
          </div>

          {/* lower: three pillars, thin rules between them */}
          <div className="relative grid border-t border-white/10 sm:grid-cols-3">
            {trust.columns.map((column, i) => (
              <TrustColumn
                key={column.id}
                title={column.title}
                body={column.body}
                className={cn(
                  i > 0 && 'border-t border-white/10 sm:border-t-0 sm:border-l',
                )}
              />
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
