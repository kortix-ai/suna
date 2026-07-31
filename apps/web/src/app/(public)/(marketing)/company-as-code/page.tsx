import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@/components/ui/separator';
import { ChangeRequest } from '@/features/marketing/company-as-code/change-request';
import { CodePanel } from '@/features/marketing/company-as-code/code-panel';
import {
  change,
  closing,
  definition,
  grep,
  hero,
  portable,
  repo,
  selfImprove,
} from '@/features/marketing/company-as-code/content';
import { RepoTree } from '@/features/marketing/company-as-code/repo-tree';
import { SectionHeading } from '@/features/marketing/company-as-code/section-heading';
import { cn } from '@/lib/utils';
import Link from 'next/link';
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
 * `/company-as-code` — the argument no competitor can copy: one `kortix.yaml`
 * and one git repo hold the whole company, so the company is greppable,
 * diffable, revertable, clonable, and able to patch itself.
 *
 * Copy lives in `features/marketing/company-as-code/content.ts` and is governed
 * by the `comms` skill. Three rules bite hardest here: every YAML key and path
 * on this page is real (schema version 2 — see
 * `packages/manifest-schema/src/index.v2.ts`), `channels:` is NOT a manifest
 * key in that schema, and nothing merges itself — work reaches `main` through a
 * change request a person approves.
 */
export default function CompanyAsCodePage(): ReactNode {
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
              <Button size="xl" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </Button>
              <Button size="xl" variant="secondary" asChild>
                <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
              </Button>
            </div>
            <p className="text-muted-foreground mt-6 font-mono text-xs tracking-wider uppercase">
              {hero.microline}
            </p>
          </Reveal>

          {/* the four facts the rest of the page proves */}
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

      {/* ── 1 · the two files that define the company ───────────────────── */}
      <section id="definition" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading
          eyebrow={definition.eyebrow}
          title={definition.title}
          sub={definition.sub}
        />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="min-w-0 lg:col-span-7">
            <CodePanel
              title={definition.yaml.title}
              caption={definition.yaml.caption}
              lines={definition.yaml.lines}
              lang="yaml"
            />
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:col-span-5">
            <div className="flex h-full flex-col gap-4">
              <CodePanel
                title={definition.runtime.title}
                caption={definition.runtime.caption}
                lines={definition.runtime.lines}
                lang="jsonc"
                className="h-auto"
              />
              <CodePanel
                title={definition.agentFile.title}
                caption={definition.agentFile.caption}
                lines={definition.agentFile.lines}
                lang="md"
                className="h-auto"
              />
              {/* Absorbs whatever height the manifest column has left, so the
                  two columns end on the same line at `lg` and the code panels
                  never sit above a void. */}
              <ul className="border-border bg-card flex flex-1 flex-col justify-center gap-6 rounded-sm border p-6 sm:p-7">
                {definition.notes.map((note) => (
                  <li key={note.id} className="border-border border-t pt-5 first:border-t-0 first:pt-0">
                    <h3 className="text-foreground text-sm font-medium">{note.title}</h3>
                    <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                      {note.body}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 2 · what is in the repo, and what deliberately is not ───────── */}
      <section id="repo" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={repo.eyebrow} title={repo.title} sub={repo.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="min-w-0 lg:col-span-7">
            <RepoTree />
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:col-span-5">
            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8">
              <h3 className="text-foreground text-base leading-tight font-medium">
                {repo.outsideTitle}
              </h3>
              <dl className="mt-6 grid gap-6">
                {repo.outside.map((item) => (
                  <div key={item.id} className="border-border border-t pt-5 first:border-t-0 first:pt-0">
                    <dt className="text-foreground font-mono text-[11px] tracking-widest uppercase">
                      {item.k}
                    </dt>
                    <dd className="text-muted-foreground mt-2.5 text-sm leading-relaxed">
                      {item.v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 3 · grep your whole company ─────────────────────────────────── */}
      <section id="grep" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={grep.eyebrow} title={grep.title} sub={grep.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="min-w-0 lg:col-span-7">
            <CodePanel title={grep.shell.title} lines={grep.shell.lines} lang="sh" />
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:col-span-5">
            <div className="grid h-full gap-4">
              {grep.cards.map((card) => (
                <div
                  key={card.id}
                  className="border-border bg-card flex flex-col justify-center rounded-sm border p-6"
                >
                  <h3 className="text-foreground text-base leading-tight font-medium">
                    {card.title}
                  </h3>
                  <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">
                    {card.body}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 4 · a skill change lands as a reviewed commit ───────────────── */}
      <section id="change" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={change.eyebrow} title={change.title} sub={change.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="min-w-0 lg:col-span-8">
            <ChangeRequest />
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:col-span-4">
            <div className="grid h-full gap-4">
              {change.points.map((point) => (
                <div
                  key={point.id}
                  className="border-border bg-card flex h-full flex-col justify-center rounded-sm border p-6 sm:p-7"
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

      {/* ── 5 · the company patches itself, on a schedule ───────────────── */}
      <section id="self-improve" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading
          eyebrow={selfImprove.eyebrow}
          title={selfImprove.title}
          sub={selfImprove.sub}
        />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="min-w-0 lg:col-span-5">
            <CodePanel
              title={selfImprove.yaml.title}
              caption={selfImprove.yaml.caption}
              lines={selfImprove.yaml.lines}
              lang="yaml"
            />
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:col-span-7">
            <ol className="border-border grid h-full overflow-hidden rounded-sm border sm:grid-cols-2">
              {selfImprove.steps.map((step, i) => (
                <li
                  key={step.n}
                  className={cn(
                    'border-border bg-card flex flex-col p-6 sm:p-7',
                    i > 0 && 'border-t',
                    i % 2 === 1 && 'sm:border-l',
                    i === 1 && 'sm:border-t-0',
                  )}
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
        </div>
      </section>

      <SectionDivider />

      {/* ── 6 · it is a git repo, so it walks out the door with you ─────── */}
      <section id="portable" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={portable.eyebrow} title={portable.title} sub={portable.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="min-w-0 lg:col-span-5">
            <CodePanel title={portable.shell.title} lines={portable.shell.lines} lang="sh" />
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:col-span-7">
            <dl className="border-border bg-card h-full overflow-hidden rounded-sm border">
              {portable.rows.map((row, i) => (
                <div
                  key={row.id}
                  className={cn(
                    'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8',
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
        </div>
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
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              {closing.sub}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="xl" asChild>
                <Link href={closing.ctaPrimaryHref}>{closing.ctaPrimary}</Link>
              </Button>
              <Button size="xl" variant="secondary" asChild>
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
