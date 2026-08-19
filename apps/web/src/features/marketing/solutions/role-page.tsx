import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArtifactPanel } from './artifact';
import { ROLES } from './registry';
import {
  DefinitionRows,
  Eyebrow,
  Section,
  SectionDivider,
  SectionHeading,
  SOLUTIONS_MEASURE,
  SpecGrid,
} from './shared';
import type { RoleContent } from './types';

const MODE_STEP: Record<RoleContent['cadence']['modes'][number]['id'], string> = {
  'on-demand': '01',
  'human-assisted': '02',
  automated: '03',
};

/**
 * The one renderer behind all eight `/solutions/<role>` pages.
 *
 * The skeleton is shared on purpose — a section of eight pages that each
 * invented its own layout would read as eight pages, not one section. What is
 * NOT shared is the copy: every role file is written from scratch about that
 * role's actual work, and the specimen artifact changes shape with the role
 * (a patch for engineering, a reconciliation for finance, a query for data
 * science, a document for the writing roles).
 *
 * The accuracy gate that governs every word on these pages lives in
 * `./types.ts`. Read it before editing any role file.
 */
export function RolePage({ role }: { role: RoleContent }): ReactNode {
  const others = ROLES.filter((item) => item.slug !== role.slug);

  return (
    <div className="bg-background relative">
      {/* ── hero ────────────────────────────────────────────────────────── */}
      <section className={cn(SOLUTIONS_MEASURE, 'relative pt-32 pb-12 sm:pt-36')}>
        <Reveal>
          <Badge variant="kortix" className="rounded">
            Solutions · {role.name}
          </Badge>
          <h1 className="text-foreground mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            {role.hero.title}
          </h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">
            {role.hero.sub}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/auth">Get started</Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href="/contact">Talk to us</Link>
            </Button>
          </div>
          <p className="text-muted-foreground mt-6 font-mono text-xs tracking-wider uppercase">
            {role.hero.microline}
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <SpecGrid specs={role.hero.specs} />
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 1 · what you hand off ───────────────────────────────────────── */}
      <Section id="handoff">
        <SectionHeading eyebrow="The handoff" title={role.handoff.title} sub={role.handoff.sub} />

        {/* Individually bordered cards rather than one continuous hairline grid: the job
            count varies by role (four to six), so a hand-written hairline table
            would need a different rule set per page. */}
        <Reveal delay={0.06}>
          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {role.handoff.jobs.map((job, i) => (
              <li
                key={job.id}
                className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
              >
                <Eyebrow>{String(i + 1).padStart(2, '0')}</Eyebrow>
                <h3 className="text-foreground mt-3 text-base leading-tight font-medium">
                  {job.title}
                </h3>
                <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">{job.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </Section>

      <SectionDivider />

      {/* ── 2 · what comes back ─────────────────────────────────────────── */}
      <Section id="output">
        <SectionHeading eyebrow="The output" title={role.output.title} sub={role.output.sub} />

        <div className="mt-10 grid gap-4 lg:grid-cols-12">
          {/* `min-w-0` on both grid items: the artifact frame contains a wide
              table and a `min-w-max` <pre>, and a grid item's default
              `min-width: auto` would let that width escape the column and
              scroll the whole page at 390px. */}
          <Reveal delay={0.06} className="min-w-0 lg:col-span-7">
            <figure className="m-0 min-w-0">
              <ArtifactPanel artifact={role.output.artifact} />
              <figcaption className="text-muted-foreground mt-3 font-mono text-[11px] tracking-wide">
                {role.output.caption}
              </figcaption>
            </figure>
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:col-span-5">
            <div className="grid h-full gap-4">
              {role.output.notes.map((note) => (
                <div
                  key={note.id}
                  className="border-border bg-card flex h-full flex-col rounded-sm border p-6"
                >
                  <h3 className="text-foreground text-base leading-tight font-medium">
                    {note.title}
                  </h3>
                  <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">
                    {note.body}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </Section>

      <SectionDivider />

      {/* ── 3 · where it reaches ────────────────────────────────────────── */}
      <Section id="reach">
        <SectionHeading eyebrow="Where it reaches" title={role.reach.title} sub={role.reach.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <DefinitionRows rows={role.reach.rows} keyClassName="normal-case tracking-normal" />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="border-border text-muted-foreground mt-6 max-w-3xl border-t pt-4 text-sm leading-relaxed">
            {role.reach.footnote}
          </p>
        </Reveal>
      </Section>

      <SectionDivider />

      {/* ── 4 · how it runs ─────────────────────────────────────────────── */}
      <Section id="cadence">
        <SectionHeading eyebrow="How it runs" title={role.cadence.title} sub={role.cadence.sub} />

        <Reveal delay={0.06}>
          <ol className="border-border bg-card mt-10 grid overflow-hidden rounded-sm border lg:grid-cols-3">
            {role.cadence.modes.map((mode, i) => (
              <li
                key={mode.id}
                className={cn(
                  'border-border flex flex-col p-6 sm:p-8',
                  i > 0 && 'border-t lg:border-t-0 lg:border-l',
                )}
              >
                <div className="flex items-baseline gap-3">
                  <Eyebrow>{MODE_STEP[mode.id]}</Eyebrow>
                  <Eyebrow className="text-foreground">{mode.label}</Eyebrow>
                </div>
                <h3 className="text-foreground mt-4 text-base leading-tight font-medium">
                  {mode.title}
                </h3>
                <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">{mode.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </Section>

      <SectionDivider />

      {/* ── 5 · what lands, and what does not ───────────────────────────── */}
      <Section id="control">
        <SectionHeading eyebrow="Control" title={role.control.title} sub={role.control.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <DefinitionRows rows={role.control.rows} />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" variant="secondary" asChild>
              <Link href="/security">How the isolation works</Link>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <Link href="/connectors">How connectors are brokered</Link>
            </Button>
          </div>
        </Reveal>
      </Section>

      <SectionDivider />

      {/* ── 6 · the other teams ─────────────────────────────────────────── */}
      <Section id="other-teams">
        <Reveal>
          <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
            The same platform, the other teams
          </h2>
          <p className="text-muted-foreground mt-4 max-w-2xl text-base leading-relaxed">
            One project, one set of connectors, one memory that compounds. Each team writes the
            skills for its own work; nobody stands up a second system.
          </p>
        </Reveal>

        <Reveal delay={0.06}>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((item) => (
              <li key={item.slug}>
                <Link
                  href={`/solutions/${item.slug}`}
                  className="border-border bg-card hover:bg-accent/40 flex h-full flex-col rounded-sm border p-5 transition-colors"
                >
                  <span className="text-foreground text-sm font-medium">{item.name}</span>
                  <span className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                    {item.navDescription}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.1}>
          <Link
            href="/solutions"
            className="text-foreground hover:text-muted-foreground mt-6 inline-block font-mono text-xs tracking-wider uppercase transition-colors"
          >
            All solutions →
          </Link>
        </Reveal>
      </Section>

      {/* ── closing ─────────────────────────────────────────────────────── */}
      <Section id="cta">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-6 rounded-sm border p-8 sm:p-12">
            <Badge variant="kortix" className="rounded">
              {role.name}
            </Badge>
            <h2 className="text-foreground max-w-2xl text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
              {role.closing.title}
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              {role.closing.sub}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="xl" asChild>
                <Link href="/auth">Get started</Link>
              </Button>
              <Button size="xl" variant="secondary" asChild>
                <Link href="/contact">Talk to us</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </Section>

      <div className="h-24 sm:h-28" />
    </div>
  );
}
