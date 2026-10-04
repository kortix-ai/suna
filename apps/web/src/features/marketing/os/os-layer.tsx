'use client';

import Link from '@/components/site-link';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import { osLayer } from './content';
import { CardArrow, PillLink } from './primitives';

const COLS = 24;
const ROWS = 11;

/** Tag positions on the lattice, in grid cells. Hand-placed around the centre
 *  so no tag covers the headline. */
const TAG_AT: readonly [col: number, row: number][] = [
  [3, 1], [17, 1], [9, 2], [21, 3], [1, 4], [20, 7], [2, 8], [15, 9], [7, 10], [22, 10],
];

/** Dots that carry the accent: a sparse, fixed scatter, never random per render. */
const ACCENT = new Set([5, 31, 58, 77, 102, 121, 146, 170, 199, 216, 238, 257]);

/**
 * The operating layer, drawn instead of screenshotted: a lattice of dots, the
 * product's parts typing in as tags, and the mark in the middle. A dark art
 * pane in both themes (`graphic-elements.md`).
 */
export function Lattice() {
  return (
    <div aria-hidden className="absolute inset-0">
      <div
        className="grid size-full"
        style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)`, gridTemplateRows: `repeat(${ROWS}, 1fr)` }}
      >
        {Array.from({ length: COLS * ROWS }, (_, i) => (
          <span key={i} className="flex items-center justify-center">
            <span
              className={cn(
                'size-1 rounded-full motion-safe:animate-[kx-os-dot_4s_ease-out_infinite]',
                ACCENT.has(i) ? 'bg-kortix-base' : 'bg-foreground/25',
              )}
              style={{ animationDelay: `${((i % COLS) + Math.floor(i / COLS)) * 90}ms` }}
            />
          </span>
        ))}
      </div>
      {osLayer.tags.map((tag, i) => {
        const [col, row] = TAG_AT[i];
        return (
          <span
            key={tag}
            className="border-border bg-background/80 text-foreground absolute flex -translate-y-1/2 items-center gap-2 rounded-sm border px-2 py-1 font-mono text-xs motion-safe:animate-[kx-fade_600ms_ease-out_both]"
            style={{
              left: `${(col / COLS) * 100}%`,
              top: `${((row + 0.5) / ROWS) * 100}%`,
              animationDelay: `${300 + i * 180}ms`,
            }}
          >
            <span className="bg-kortix-base size-1.5" />
            {tag}
          </span>
        );
      })}
    </div>
  );
}

export function OsLayer() {
  return (
    <section className="dark bg-background text-foreground">
      <div className="relative flex min-h-[44rem] items-center justify-center overflow-hidden px-6 py-30">
        <Lattice />
        <div className="relative z-10 flex max-w-2xl flex-col items-center gap-6 text-center">
          <span className="flex items-center gap-2 text-lg">
            <KortixLogo size={18} />
            <span className="text-muted-foreground">{osLayer.mark}</span>
          </span>
          <h2 className="text-foreground text-3xl font-normal tracking-tight text-balance sm:text-5xl">
            {osLayer.title}
          </h2>
          <PillLink href={osLayer.cta.href}>{osLayer.cta.label}</PillLink>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl gap-4 px-6 pb-24 md:grid-cols-2 md:pb-30">
        {osLayer.cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group border-border relative flex min-h-[32rem] flex-col justify-end overflow-hidden rounded-xl border"
          >
            {card.art === 'beams' ? (
              <BeamsShader />
            ) : (
              // A still of the Neuro wallpaper (dark), not the live shader: the
              // shader follows the page theme, and this pane is dark in both.
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/media/os/neuro-dark.webp" alt="" aria-hidden className="absolute inset-0 size-full object-cover" />
            )}
            <div className="from-background absolute inset-0 bg-linear-to-t via-background/60 to-transparent" aria-hidden />
            <div className="relative flex items-end justify-between gap-6 p-8">
              <div className="max-w-sm space-y-3">
                <h3 className="text-foreground text-3xl font-normal tracking-tight text-balance">{card.title}</h3>
                <p className="text-muted-foreground text-base text-pretty">{card.body}</p>
                <span className="text-foreground inline-block pt-2 text-sm underline underline-offset-4">{card.cta}</span>
              </div>
              <CardArrow className="text-foreground" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
