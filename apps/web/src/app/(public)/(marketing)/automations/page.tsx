import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@/components/ui/separator';
import { CodePanel } from '@/features/marketing/agent-computer/code-panel';
import { SectionHeading } from '@/features/marketing/agent-computer/section-heading';
import {
  closing,
  declared,
  hero,
  review,
  schedule,
  session,
  types,
  webhook,
} from '@/features/marketing/automations/content';
import { ScheduleTable } from '@/features/marketing/automations/schedule-table';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Hairlines for a 4-up grid that reflows 1 → 2 → 4 columns. Written per index
 * because the divider a cell needs changes with the breakpoint: cell 3 is a new
 * row at `sm` (top rule) and a new column at `lg` (left rule). Same table as
 * `/agent-computer`, so the three capability pages share one rhythm.
 */
const GRID_4_RULES = [
  '',
  'border-t sm:border-t-0 sm:border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t sm:border-l lg:border-t-0',
] as const;

function SectionDivider(): ReactNode {
  return (
    <div className="mx-auto max-w-7xl px-6">
      <Separator />
    </div>
  );
}

/**
 * `/automations` — the page for work that starts with nobody in the room.
 *
 * Copy lives in `features/marketing/automations/content.ts` and is governed by
 * the `comms` skill. The accuracy gate that bites hardest here: there are two
 * trigger types and four session modes, and a trigger has no "deliver the
 * result somewhere" field. See the header of `content.ts`.
 */
export default function AutomationsPage(): ReactNode {
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
                <div
                  key={spec.k}
                  className={cn('border-border px-5 py-6 sm:px-6', GRID_4_RULES[i])}
                >
                  <dt className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                    {spec.k}
                  </dt>
                  <dd className="text-foreground mt-2.5 text-sm leading-snug">{spec.v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 1 · cron or webhook, and nothing else ───────────────────────── */}
      <section id="types" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeading eyebrow={types.eyebrow} title={types.title} sub={types.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {types.cards.map((card) => (
              <div
                key={card.id}
                className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
              >
                <span className="border-border text-muted-foreground w-fit rounded-sm border px-2 py-1 font-mono text-[10px] tracking-widest uppercase">
                  {card.kind}
                </span>
                <h3 className="text-foreground mt-6 text-lg leading-tight font-medium">
                  {card.title}
                </h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {types.notes.map((note) => (
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

      {/* ── 2 · the schedule, as a table ────────────────────────────────── */}
      <section id="schedule" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeading eyebrow={schedule.eyebrow} title={schedule.title} sub={schedule.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <ScheduleTable />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {schedule.facts.map((fact) => (
              <div key={fact.id} className="border-border border-t pt-4">
                <dt className="text-foreground text-sm font-medium">{fact.k}</dt>
                <dd className="text-muted-foreground mt-2 text-sm leading-relaxed">{fact.v}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 3 · the automation is a file ────────────────────────────────── */}
      <section id="declared" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeading eyebrow={declared.eyebrow} title={declared.title} sub={declared.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CodePanel title={declared.yaml.title} lines={declared.yaml.lines} lang="yaml" />
            <CodePanel title={declared.shell.title} lines={declared.shell.lines} lang="sh" />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="border-border mt-6 border-t pt-4">
            <h3 className="text-foreground text-sm font-medium">{declared.template.title}</h3>
            <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-relaxed">
              {declared.template.body}
            </p>
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 4 · webhooks are signed or they are nothing ─────────────────── */}
      <section id="webhooks" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeading eyebrow={webhook.eyebrow} title={webhook.title} sub={webhook.sub} />

        <Reveal delay={0.06}>
          <div className="border-border bg-card mt-10 rounded-sm border">
            <div className="border-border border-b px-6 py-5 sm:px-8">
              <p className="text-foreground overflow-x-auto font-mono text-[12.5px] whitespace-pre">
                {webhook.endpoint}
              </p>
              <p className="text-muted-foreground mt-3 overflow-x-auto font-mono text-[12.5px] whitespace-pre">
                {webhook.header}
              </p>
              <p className="text-muted-foreground/70 mt-3 max-w-2xl text-sm leading-relaxed">
                {webhook.headerNote}
              </p>
            </div>

            <dl>
              {webhook.rows.map((row, i) => (
                <div
                  key={row.code}
                  className={cn(
                    'border-border grid gap-2 px-6 py-5 sm:grid-cols-12 sm:gap-8 sm:px-8',
                    i > 0 && 'border-t',
                  )}
                >
                  <dt className="text-foreground font-mono text-[13px] tabular-nums sm:col-span-2">
                    {row.code}
                  </dt>
                  <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-10">
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="border-border text-muted-foreground mt-6 max-w-3xl border-t pt-4 text-sm leading-relaxed">
            {webhook.footnote}
          </p>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 5 · which session a fire lands in ───────────────────────────── */}
      <section id="session" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeading eyebrow={session.eyebrow} title={session.title} sub={session.sub} />

        <Reveal delay={0.06}>
          <ol className="border-border mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
            {session.steps.map((step, i) => (
              <li
                key={step.mode}
                className={cn(
                  'border-border bg-card flex flex-col p-6 sm:p-7',
                  GRID_4_RULES[i],
                )}
              >
                <span className="text-muted-foreground/45 font-mono text-xs tracking-widest tabular-nums">
                  {step.n}
                </span>
                <h3 className="text-foreground mt-6 font-mono text-lg leading-tight">
                  {step.mode}
                </h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="border-border text-muted-foreground mt-6 max-w-3xl border-t pt-4 text-sm leading-relaxed">
            {session.footnote}
          </p>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 6 · the 3am fire still faces a person ───────────────────────── */}
      <section id="review" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeading eyebrow={review.eyebrow} title={review.title} sub={review.sub} />

        <Reveal delay={0.06}>
          <dl className="border-border bg-card mt-10 overflow-hidden rounded-sm border">
            {review.rows.map((row, i) => (
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
                <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-8">
                  {row.v}
                </dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>

      {/* ── closing ─────────────────────────────────────────────────────── */}
      <section id="cta" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-6 rounded-sm border p-8 sm:p-12">
            <Badge variant="kortix" className="rounded">
              {closing.eyebrow}
            </Badge>
            <h2 className="text-foreground max-w-2xl text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
              {closing.title}
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              {closing.sub}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href={closing.ctaPrimaryHref}>{closing.ctaPrimary}</Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href={closing.ctaSecondaryHref}>{closing.ctaSecondary}</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </section>

      <div className="h-24 sm:h-28" />
    </div>
  );
}
