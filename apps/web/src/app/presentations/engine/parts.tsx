'use client';

/**
 * Presentation building blocks — a 1:1 mirror of the marketing homepage idiom
 * (apps/web home sections). Same vocabulary everywhere: mono-uppercase eyebrows,
 * `text-3xl/4xl font-medium tracking-tight` titles, `rounded-sm` thin-border
 * panels on `bg-card`, `font-medium` body weight, `KortixAsterisk` bullets, and
 * the marketing `Button`/`Badge`. Slides are responsive full-viewport sections
 * (like a homepage section), theme-following — never a forced palette.
 */

import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';
import { m } from 'motion/react';
import type { ReactNode } from 'react';

/* ── Rise: the deck's stagger ───────────────────────────────────────────────
   The engine cross-fades the slide as a whole; `Rise` gives the blocks inside
   it their own entrance so a slide assembles instead of appearing. Index-based
   delay rather than an IntersectionObserver (`components/home/reveal`), because
   every block on a slide is already in view the moment the slide mounts — an
   observer would fire them all at once and there would be no stagger at all. */

export function Rise({
  children,
  /** Position in the slide's reading order. One step ≈ 90 ms. */
  i = 0,
  className,
}: {
  children: ReactNode;
  i?: number;
  className?: string;
}) {
  return (
    <m.div
      initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.7, delay: 0.1 + i * 0.09, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </m.div>
  );
}

/* ── Slide frame: one full-viewport homepage-style section ─────────────── */

export function Slide({
  children,
  className,
  innerClassName,
  align = 'center',
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={cn(
        'relative flex h-full min-h-full w-full overflow-y-auto',
        align === 'center' ? 'items-center' : 'items-start',
        className,
      )}
    >
      <div
        className={cn(
          'mx-auto w-full max-w-6xl px-6 py-24 sm:py-28 lg:px-0',
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* ── Section header (eyebrow + title + lead), exactly like home sections ── */

export function SectionHead({
  eyebrow,
  title,
  lead,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('max-w-2xl space-y-3', className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">{title}</h2>
      {lead ? <p className="text-muted-foreground text-base leading-relaxed">{lead}</p> : null}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-muted-foreground font-mono text-xs tracking-wider uppercase',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Accent-weighted word inside a title (muted, matches home's secondary tone). */
export function Dim({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-muted-foreground text-base leading-relaxed', className)}>{children}</p>
  );
}

/** Mono inline token, e.g. kortix.yaml */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono', className)}>{children}</span>;
}

/* ── Panel: the home card — rounded-sm, thin border, bg-card ───────────── */

export function Panel({
  children,
  className,
  inverted,
}: {
  children: ReactNode;
  className?: string;
  inverted?: boolean;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-sm border',
        inverted ? 'border-border bg-foreground text-background' : 'border-border bg-card',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Mono label chip — the home step label (`bg-primary text-background`). */
export function LabelChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'bg-primary text-background w-fit rounded px-2 py-1 font-mono text-xs tracking-wider',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Outline mono pill (mirrors hero install-chip border treatment). */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'border-border bg-card text-muted-foreground inline-flex w-fit items-center gap-2 rounded-sm border px-3 py-1.5 font-mono text-xs',
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Bulleted list with the KortixAsterisk glyph (home idiom) ──────────── */

export function Bullets({
  items,
  index = 0,
  className,
}: {
  items: ReactNode[];
  index?: number;
  className?: string;
}) {
  return (
    <ul className={cn('text-muted-foreground space-y-2 text-[15px] leading-relaxed', className)}>
      {items.map((it, i) => (
        <li key={i} className="flex gap-2">
          <KortixAsterisk index={index + i} />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Product screenshot in a framed card (home uses real screenshots) ──── */

export function Shot({
  src,
  alt,
  url = 'kortix.com',
  chrome = true,
  className,
  /**
   * Sizing for the image itself. A slide is one viewport with no scroll, so a
   * full-resolution screenshot has to be capped in `vh` — `max-h-[54vh]
   * object-cover object-top` keeps the top of the screen (where the product is)
   * and crops the empty bottom rather than letterboxing it.
   */
  imgClassName,
}: {
  src: string;
  alt: string;
  url?: string;
  chrome?: boolean;
  className?: string;
  imgClassName?: string;
}) {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-sm border', className)}>
      {chrome ? (
        <div className="border-border flex items-center gap-1.5 border-b px-3 py-2">
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted text-muted-foreground ml-2 truncate rounded-sm px-2.5 py-0.5 font-mono text-xs">
            {url}
          </span>
        </div>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className={cn('block w-full select-none', imgClassName)}
        draggable={false}
      />
    </div>
  );
}

/* ── Terminal block (mirrors hero/CLI mono surfaces) ───────────────────── */

export function Terminal({
  title = 'zsh',
  lines,
  className,
}: {
  title?: string;
  lines: { kind: 'cmd' | 'out' | 'comment'; text: string }[];
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-sm border', className)}>
      <div className="border-border flex items-center gap-1.5 border-b px-3 py-2">
        <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        <span className="text-muted-foreground ml-2 font-mono text-xs">{title}</span>
      </div>
      <div className="flex flex-col gap-1.5 p-5 font-mono text-sm leading-relaxed">
        {lines.map((l, i) => {
          if (l.kind === 'comment')
            return (
              <div key={i} className="text-muted-foreground/60">
                {l.text}
              </div>
            );
          if (l.kind === 'out')
            return (
              <div key={i} className="text-muted-foreground">
                {l.text}
              </div>
            );
          return (
            <div key={i} className="text-foreground">
              <span className="text-muted-foreground">$ </span>
              {l.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Key/value rows — the /security page's workhorse block ─────────────── */

export function RowList({
  rows,
  className,
  /**
   * Build support: rows past this index stay ghosted instead of unmounting, so
   * revealing one does not reflow the ones already on screen. Omit to show all.
   */
  upTo,
}: {
  rows: readonly { readonly id: string; readonly k: string; readonly v: ReactNode }[];
  className?: string;
  upTo?: number;
}) {
  return (
    <dl className={cn('border-border bg-card overflow-hidden rounded-sm border', className)}>
      {rows.map((row, i) => (
        <m.div
          key={row.id}
          animate={{ opacity: upTo === undefined || i <= upTo ? 1 : 0.12 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            'border-border grid gap-1.5 px-5 py-4 sm:grid-cols-12 sm:gap-8 sm:px-7 sm:py-5',
            i > 0 && 'border-t',
          )}
        >
          <dt className="text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4">
            {row.k}
          </dt>
          <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-8">{row.v}</dd>
        </m.div>
      ))}
    </dl>
  );
}

/* ── Spec strip — the four mono facts under a /security-style hero ─────── */

/**
 * Hairlines for a 4-up grid that reflows 1 → 2 → 4 columns, written per index:
 * the divider a cell needs changes with the breakpoint. Cell 3 starts a new row
 * at `sm` (top rule) and a new column at `lg` (left rule).
 */
const GRID_4_RULES = [
  '',
  'border-t sm:border-t-0 sm:border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t sm:border-l lg:border-t-0',
] as const;

export function SpecStrip({
  specs,
  className,
}: {
  specs: readonly { readonly k: string; readonly v: string }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'border-border bg-card grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {specs.map((spec, i) => (
        <div key={spec.k} className={cn('border-border px-5 py-5', GRID_4_RULES[i])}>
          <dt className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            {spec.k}
          </dt>
          <dd className="text-foreground mt-2 text-sm leading-snug">{spec.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Numbered steps — the "how work lands" 4-up ────────────────────────── */

export function Steps({
  steps,
  className,
}: {
  steps: readonly { readonly n: string; readonly title: string; readonly body: string }[];
  className?: string;
}) {
  return (
    <ol
      className={cn(
        'border-border grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {steps.map((step, i) => (
        <li
          key={step.n}
          className={cn('border-border bg-card flex flex-col p-5 sm:p-6', GRID_4_RULES[i])}
        >
          <span className="text-muted-foreground/45 font-mono text-xs tracking-widest tabular-nums">
            {step.n}
          </span>
          <h3 className="text-foreground mt-5 text-base leading-tight font-medium">{step.title}</h3>
          <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">{step.body}</p>
        </li>
      ))}
    </ol>
  );
}

/* ── Sub-card used inside grids (home sub-panel) ───────────────────────── */

export function MiniCard({
  label,
  title,
  body,
  className,
}: {
  label?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card flex flex-col gap-2 rounded-sm border p-6', className)}>
      {label ? (
        <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {label}
        </span>
      ) : null}
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      {body ? <p className="text-muted-foreground text-[15px] leading-relaxed">{body}</p> : null}
    </div>
  );
}
