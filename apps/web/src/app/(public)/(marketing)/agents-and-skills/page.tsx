import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@/components/ui/separator';
import { CodePanel } from '@/features/marketing/agent-computer/code-panel';
import {
  agent,
  hero,
  marketplace,
  reach,
  repo,
  skill,
} from '@/features/marketing/agents-and-skills/content';
import { MdPanel } from '@/features/marketing/agents-and-skills/md-panel';
import { RepoTree } from '@/features/marketing/agents-and-skills/repo-tree';
import { AgentsAndSkillsHeroVisual } from '@/features/marketing/agents-and-skills/hero-visual';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Hairlines for a 4-up grid that reflows 1 → 2 → 4 columns. Written per index
 * because the divider a cell needs changes with the breakpoint: cell 3 is a new
 * row at `sm` (top rule) and a new column at `lg` (left rule). Same table as
 * `/agent-computer`, so the capability pages share one rhythm.
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
 * `/agents-and-skills` — the part of the product that compounds.
 *
 * Copy lives in `features/marketing/agents-and-skills/content.ts`, whose header
 * carries the accuracy gate. Two claims are easy to get wrong: the scoping field
 * is `permission` (never `tools`, which is a hard error), and the marketplace
 * has no deterministic installer — adding an item runs an agent import that
 * opens a change request.
 */
export default function AgentsAndSkillsPage(): ReactNode {
  return (
    <div className="bg-background relative">
      <CapabilityHero
        eyebrow={hero.eyebrow}
        title={hero.title}
        sub={hero.sub}
        ctaPrimary={hero.ctaPrimary}
        ctaPrimaryHref={hero.ctaPrimaryHref}
        ctaSecondary={hero.ctaSecondary}
        ctaSecondaryHref={hero.ctaSecondaryHref}
        visual={<AgentsAndSkillsHeroVisual />}
      />

      {/* ── 1 · an agent is two files ───────────────────────────────────── */}
      <section id="agent" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={agent.eyebrow} title={agent.title} description={agent.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MdPanel title={agent.md.title} caption={agent.md.caption} lines={agent.md.lines} />
            <CodePanel title={agent.yaml.title} lines={agent.yaml.lines} lang="yaml" />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {agent.notes.map((note) => (
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

      {/* ── 2 · the permission tree and the ceiling above it ─────────────── */}
      <section id="reach" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={reach.eyebrow} title={reach.title} description={reach.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="lg:col-span-7">
            <MdPanel title={reach.md.title} caption={reach.md.caption} lines={reach.md.lines} />
          </Reveal>

          <Reveal delay={0.1} className="lg:col-span-5">
            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-7">
              <dl className="grid gap-5">
                {reach.actions.map((action) => (
                  <div key={action.k}>
                    <dt className="text-foreground font-mono text-[13px]">{action.k}</dt>
                    <dd className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                      {action.v}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="border-border text-muted-foreground/70 mt-6 border-t pt-4 text-sm leading-relaxed">
                {reach.actionsNote}
              </p>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.14}>
          <dl className="border-border bg-card mt-4 overflow-hidden rounded-sm border">
            {reach.rows.map((row, i) => (
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

      <SectionDivider />

      {/* ── 3 · a skill is a directory ──────────────────────────────────── */}
      <section id="skill" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={skill.eyebrow} title={skill.title} description={skill.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="lg:col-span-7">
            <MdPanel title={skill.md.title} caption={skill.md.caption} lines={skill.md.lines} />
          </Reveal>

          <Reveal delay={0.1} className="lg:col-span-5">
            <div className="grid h-full gap-4">
              {skill.points.map((point) => (
                <div
                  key={point.id}
                  className="border-border bg-card flex h-full flex-col rounded-sm border p-6"
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

        <Reveal delay={0.14}>
          <dl className="border-border bg-card mt-4 grid overflow-hidden rounded-sm border sm:grid-cols-3">
            {skill.counts.map((count, i) => (
              <div
                key={count.v}
                className={cn(
                  'border-border px-6 py-6 sm:px-8',
                  i > 0 && 'border-t sm:border-t-0 sm:border-l',
                )}
              >
                <dt className="text-foreground font-mono text-3xl tabular-nums">{count.k}</dt>
                <dd className="text-muted-foreground mt-2 text-sm leading-relaxed">{count.v}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 4 · it is all text in the repo ──────────────────────────────── */}
      <section id="repo" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={repo.eyebrow} title={repo.title} description={repo.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <RepoTree />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <dl className="border-border bg-card mt-4 overflow-hidden rounded-sm border">
            {repo.rows.map((row, i) => (
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

      <SectionDivider />

      {/* ── 5 · starting from someone else's work ───────────────────────── */}
      <section id="marketplace" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={marketplace.eyebrow}
          title={marketplace.title}
          description={marketplace.sub}
        />

        <Reveal delay={0.06}>
          <ol className="border-border mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
            {marketplace.steps.map((step, i) => (
              <li
                key={step.n}
                className={cn('border-border bg-card flex flex-col p-6 sm:p-7', GRID_4_RULES[i])}
              >
                <span className="text-muted-foreground/45 font-mono text-xs tracking-widest tabular-nums">
                  {step.n}
                </span>
                <h3 className="text-foreground mt-6 text-lg leading-tight font-medium">
                  {step.title}
                </h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="border-border text-muted-foreground mt-6 max-w-3xl border-t pt-4 text-sm leading-relaxed">
            {marketplace.footnote}
          </p>
          <Button size="lg" variant="secondary" asChild className="mt-6 w-fit">
            <Link href={marketplace.ctaHref}>{marketplace.ctaLabel}</Link>
          </Button>
        </Reveal>
      </section>
    </div>
  );
}
