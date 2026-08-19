import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The measure every Solutions section rides.
 *
 * The rest of the marketing site is still on `max-w-7xl`; the site is being
 * swept onto a wider shared measure, and these pages are built on the target so
 * they do not have to be re-laid-out afterwards. Change it here and every
 * Solutions section moves together.
 */
export const SOLUTIONS_MEASURE = 'mx-auto max-w-7xl px-6';

/** Section shell. Same vertical rhythm as `/channels` and `/connectors`. */
export function Section({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section id={id} className={cn(SOLUTIONS_MEASURE, 'py-16 sm:py-24', className)}>
      {children}
    </section>
  );
}

/** The hairline between sections, inset to the same measure as the content. */
export function SectionDivider(): ReactNode {
  return (
    <div className={SOLUTIONS_MEASURE}>
      <Separator />
    </div>
  );
}

/** Eyebrow badge, headline, sub — the one heading block these pages use. */
export function SectionHeading({
  eyebrow,
  title,
  sub,
  className,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  className?: string;
}): ReactNode {
  return (
    <Reveal>
      <div className={cn('max-w-3xl', className)}>
        <Badge variant="kortix" className="rounded">
          {eyebrow}
        </Badge>
        <h2 className="text-foreground mt-6 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
          {title}
        </h2>
        <p className="text-muted-foreground mt-4 text-base leading-relaxed">{sub}</p>
      </div>
    </Reveal>
  );
}

/** A mono uppercase micro-label. The only small-caps voice on these pages. */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <span
      className={cn(
        'text-muted-foreground font-mono text-[10px] tracking-widest uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Hairlines for a grid that reflows 1 → 2 → 4 columns. Written per index because
 * the divider a cell needs changes with the breakpoint: cell 3 starts a new row
 * at `sm` (top rule) and a new column at `lg` (left rule). Same table as
 * `/channels`, so the pages share one rhythm.
 */
export const GRID_4_RULES = [
  '',
  'border-t sm:border-t-0 sm:border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t sm:border-l lg:border-t-0',
] as const;

/** The four mono facts under a hero. */
export function SpecGrid({
  specs,
}: {
  specs: readonly { readonly k: string; readonly v: string }[];
}): ReactNode {
  return (
    <dl className="border-border bg-card mt-14 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
      {specs.map((spec, i) => (
        <div key={spec.k} className={cn('border-border px-5 py-6 sm:px-6', GRID_4_RULES[i])}>
          <dt className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            {spec.k}
          </dt>
          <dd className="text-foreground mt-2.5 text-sm leading-snug">{spec.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A bordered definition list — mono key on the left, prose on the right. Used
 * for "where it reaches" and "what lands, and what does not" on every role page.
 */
export function DefinitionRows({
  rows,
  keyClassName,
}: {
  rows: readonly { readonly k: string; readonly v: string }[];
  keyClassName?: string;
}): ReactNode {
  return (
    <dl className="border-border bg-card overflow-hidden rounded-sm border">
      {rows.map((row, i) => (
        <div
          key={row.k}
          className={cn(
            'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-7',
            i > 0 && 'border-t',
          )}
        >
          <dt
            className={cn(
              'text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4',
              keyClassName,
            )}
          >
            {row.k}
          </dt>
          <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-8">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}
