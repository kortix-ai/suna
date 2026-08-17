import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@/components/ui/separator';
import { BoundaryDiagram } from '@/features/marketing/self-hosted/boundary-diagram';
import { CodePanel } from '@/features/marketing/self-hosted/code-panel';
import {
  closing,
  commands,
  firstRun,
  hero,
  models,
  parity,
  stack,
  targets,
  yours,
} from '@/features/marketing/self-hosted/content';
import { SectionHeading } from '@/features/marketing/self-hosted/section-heading';
import { StackDiagram } from '@/features/marketing/self-hosted/stack-diagram';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Hairlines for a 4-up grid that reflows 1 → 2 → 4 columns. Written per index
 * because the divider a cell needs changes with the breakpoint.
 */
const GRID_4_RULES = [
  '',
  'border-t sm:border-t-0 sm:border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t sm:border-l lg:border-t-0',
] as const;

/**
 * The same idea for the 6-up first-run grid, which reflows 1 → 2 → 3 columns.
 * Derived per index rather than by a formula so the rule a cell carries is
 * readable next to the cell it belongs to: `sm` puts cells 1/3/5 in the second
 * column, `lg` puts cells 1/2/4/5 there instead.
 */
const GRID_6_RULES = [
  '',
  'border-t sm:border-t-0 sm:border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t sm:border-l lg:border-l-0',
  'border-t lg:border-l',
  'border-t sm:border-l',
] as const;

function SectionDivider(): ReactNode {
  return (
    <div className="mx-auto max-w-7xl px-6">
      <Separator />
    </div>
  );
}

function RowList({
  rows,
}: {
  rows: readonly { readonly id: string; readonly k: string; readonly v: string }[];
}): ReactNode {
  return (
    <dl className="border-border bg-card overflow-hidden rounded-sm border">
      {rows.map((row, i) => (
        <div
          key={row.id}
          className={cn(
            'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-7',
            i > 0 && 'border-t',
          )}
        >
          <dt className="text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4">
            {row.k}
          </dt>
          <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-8">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * `/self-hosted` — run the whole thing on your own box.
 *
 * Copy lives in `features/marketing/self-hosted/content.ts`, and that file's
 * header lists the six claims this page corrects against the shipped CLI (the
 * first-run wizard does NOT ask for GitHub or a model key; air-gapped is not
 * what `kortix self-host start` gives you; there is no Redis). Read it before
 * editing a line here.
 */
export default function SelfHostedPage(): ReactNode {
  return (
    <div className="bg-background relative">
      {/* ── hero ────────────────────────────────────────────────────────── */}
      <section className="relative px-6 pt-32 pb-12 sm:pt-36">
        <div className="mx-auto max-w-7xl">
          <Reveal>
            <Badge variant="kortix" className="rounded">
              {hero.eyebrow}
            </Badge>
            <h1 className="text-foreground mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
              {hero.title}
            </h1>
            <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">
              {hero.sub}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
              </Button>
            </div>
            <p className="text-muted-foreground mt-6 font-mono text-xs tracking-wider uppercase">
              {hero.microline}
            </p>
          </Reveal>

          <Reveal delay={0.1}>
            <dl className="border-border bg-card mt-14 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
              {hero.specs.map((spec, i) => (
                <div key={spec.k} className={cn('border-border px-5 py-6 sm:px-6', GRID_4_RULES[i])}>
                  <dt className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                    {spec.k}
                  </dt>
                  <dd className="text-foreground mt-2.5 font-mono text-[13px] leading-snug">
                    {spec.v}
                  </dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 1 · what you keep ───────────────────────────────────────────── */}
      <section id="what-you-keep" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={yours.eyebrow} title={yours.title} sub={yours.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <BoundaryDiagram />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 2 · the commands ────────────────────────────────────────────── */}
      <section id="commands" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={commands.eyebrow} title={commands.title} sub={commands.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CodePanel title={commands.install.title} lines={commands.install.lines} lang="sh" />
            <CodePanel title={commands.hosts.title} lines={commands.hosts.lines} lang="sh" />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {commands.notes.map((note) => (
              <li
                key={note}
                className="border-border text-muted-foreground border-t pt-4 text-sm leading-relaxed"
              >
                {note}
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 3 · the first run ───────────────────────────────────────────── */}
      <section id="first-run" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={firstRun.eyebrow} title={firstRun.title} sub={firstRun.sub} />

        <Reveal delay={0.06}>
          <ol className="border-border bg-card mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-3">
            {firstRun.asks.items.map((item, i) => (
              <li
                key={item.n}
                className={cn('border-border flex flex-col p-6 sm:p-7', GRID_6_RULES[i])}
              >
                <span className="text-muted-foreground/45 font-mono text-xs tracking-widest tabular-nums">
                  {item.n}
                </span>
                <h3 className="text-foreground mt-6 text-base leading-tight font-medium">
                  {item.k}
                </h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{item.v}</p>
              </li>
            ))}
          </ol>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="border-border bg-card mt-4 rounded-sm border p-6 sm:p-8">
            <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {firstRun.generates.label}
            </p>
            <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {firstRun.generates.items.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="bg-muted-foreground/35 mt-[7px] size-1.5 shrink-0 rounded-full"
                  />
                  <span className="text-muted-foreground text-sm leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground border-border mt-6 border-t pt-6 text-sm leading-relaxed">
              {firstRun.generates.note}
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.14}>
          <p className="text-muted-foreground border-border mt-6 border-t pt-6 text-sm leading-relaxed">
            {firstRun.after}
          </p>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 4 · the stack ───────────────────────────────────────────────── */}
      <section id="stack" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={stack.eyebrow} title={stack.title} sub={stack.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <StackDiagram />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[stack.data, stack.updates].map((card) => (
              <div
                key={card.title}
                className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
              >
                <h3 className="text-foreground text-lg leading-tight font-medium">{card.title}</h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 5 · parity ──────────────────────────────────────────────────── */}
      <section id="parity" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={parity.eyebrow} title={parity.title} sub={parity.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <RowList rows={parity.rows} />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 6 · models ──────────────────────────────────────────────────── */}
      <section id="models" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={models.eyebrow} title={models.title} sub={models.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="lg:col-span-7">
            <CodePanel title={models.shell.title} lines={models.shell.lines} lang="sh" />
          </Reveal>

          <Reveal delay={0.1} className="lg:col-span-5">
            <div className="grid h-full gap-4">
              {models.points.map((point) => (
                <div
                  key={point.id}
                  className="border-border bg-card flex h-full flex-col justify-center rounded-sm border p-6"
                >
                  <h3 className="text-foreground text-base leading-tight font-medium">
                    {point.title}
                  </h3>
                  <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{point.body}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 7 · where it runs ───────────────────────────────────────────── */}
      <section id="targets" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={targets.eyebrow} title={targets.title} sub={targets.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <RowList rows={targets.rows} />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <dl className="border-border bg-card mt-4 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
            {targets.sizing.items.map((item, i) => (
              <div key={item.k} className={cn('border-border px-5 py-6 sm:px-6', GRID_4_RULES[i])}>
                <dt className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                  {item.k}
                </dt>
                <dd className="text-foreground mt-2.5 text-sm leading-snug">{item.v}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>

      {/* ── closing ─────────────────────────────────────────────────────── */}
      <section id="cta" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-6 rounded-sm border p-8 sm:p-12">
            <Badge variant="kortix" className="rounded">
              {closing.eyebrow}
            </Badge>
            <h2 className="text-foreground max-w-2xl text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
              {closing.title}
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">{closing.sub}</p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href={closing.ctaPrimaryHref}>{closing.ctaPrimary}</Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href={closing.ctaSecondaryHref}>{closing.ctaSecondary}</Link>
              </Button>
            </div>
            <p className="text-muted-foreground border-border w-full border-t pt-6 text-sm leading-relaxed">
              {closing.tertiary}{' '}
              <Link
                href={closing.tertiaryHref}
                className="text-foreground underline underline-offset-4"
              >
                {closing.tertiaryLabel}
              </Link>
              .
            </p>
          </div>
        </Reveal>
      </section>

      <div className="h-24 sm:h-28" />
    </div>
  );
}
