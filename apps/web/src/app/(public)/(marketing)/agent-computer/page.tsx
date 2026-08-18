import { Reveal } from '@/components/home/reveal';
import { Separator } from '@/components/ui/separator';
import { BranchGraph } from '@/features/marketing/agent-computer/branch-graph';
import { CodePanel } from '@/features/marketing/agent-computer/code-panel';
import {
  boot,
  control,
  declared,
  files,
  hero,
  isolation,
  parallel,
} from '@/features/marketing/agent-computer/content';
import { FileTree } from '@/features/marketing/agent-computer/file-tree';
import { AgentComputerHeroVisual } from '@/features/marketing/agent-computer/hero-visual';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * Hairlines for a 4-up grid that reflows 1 → 2 → 4 columns. Written per index
 * because the divider a cell needs changes with the breakpoint: cell 3 is a new
 * row at `sm` (top rule) and a new column at `lg` (left rule).
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
 * `/agent-computer` — the one page that explains the primitive under every
 * other page: a session is a machine.
 *
 * Copy lives in `features/marketing/agent-computer/content.ts` and is governed
 * by the `comms` skill. Three rules bite hardest here: never write "container"
 * (the nouns are "agent computer", "cloud computer", "sandbox"); never invent a
 * number ("3,000+ apps" is the only sanctioned one); and never claim blanket
 * "microVM isolation" or a secret "the model never sees" — see the accuracy
 * gate at the top of `content.ts`.
 */
export default function AgentComputerPage(): ReactNode {
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
        visual={<AgentComputerHeroVisual />}
      />

      {/* ── 1 · what happens when a session starts ──────────────────────── */}
      <section id="boot" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={boot.eyebrow} title={boot.title} description={boot.sub} />

        <Reveal delay={0.06}>
          <ol className="border-border mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
            {boot.steps.map((step, i) => (
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
      </section>

      <SectionDivider />

      {/* ── 2 · the agent owns the whole machine ────────────────────────── */}
      <section id="control" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={control.eyebrow} title={control.title} description={control.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {control.cards.map((card) => (
              <div
                key={card.id}
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

      {/* ── 3 · the diagram: main → session branches → change request ───── */}
      <section id="parallel" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={parallel.eyebrow}
          title={parallel.title}
          description={parallel.sub}
        />

        <Reveal delay={0.1}>
          <div className="mt-6">
            <BranchGraph />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 4 · the machine is declared in the repo ─────────────────────── */}
      <section id="declared" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={declared.eyebrow}
          title={declared.title}
          description={declared.sub}
        />

        <Reveal delay={0.06}>
          {/* `min-w-0` on every column: a grid item defaults to `min-width:auto`,
              so the `overflow-x-auto` scroller inside CodePanel would otherwise
              widen the page instead of scrolling itself. */}
          <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CodePanel
              title={declared.yaml.title}
              lines={declared.yaml.lines}
              lang="yaml"
              className="min-w-0"
            />
            <CodePanel
              title={declared.shell.title}
              lines={declared.shell.lines}
              lang="sh"
              className="min-w-0"
            />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 5 · everything the machine runs on is a file ────────────────── */}
      <section id="files" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={files.eyebrow} title={files.title} description={files.sub} />

        {/* Three tiles on one grid: tree spans two rows, points sit beside it.
            `min-w-0` on every cell — see the note on the `declared` grid. */}
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12 lg:grid-rows-2">
          <Reveal delay={0.06} className="min-w-0 sm:col-span-2 lg:col-span-8 lg:row-span-2">
            <FileTree />
          </Reveal>

          {files.points.map((point, i) => (
            <Reveal key={point.id} delay={0.1 + i * 0.04} className="min-w-0 lg:col-span-4">
              <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6">
                <h3 className="text-foreground text-base leading-tight font-medium text-balance">
                  {point.title}
                </h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed text-pretty">
                  {point.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <SectionDivider />

      {/* ── 6 · the walls around a machine that can do anything ─────────── */}
      <section id="isolation" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={isolation.eyebrow}
          title={isolation.title}
          description={isolation.sub}
        />

        <Reveal delay={0.06}>
          <dl className="border-border bg-card mt-10 overflow-hidden rounded-sm border">
            {isolation.rows.map((row, i) => (
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
    </div>
  );
}
