import { Reveal } from '@/components/home/reveal';
import { Separator } from '@/components/ui/separator';
import { ChangeRequest } from '@/features/marketing/company-as-code/change-request';
import { CodePanel } from '@/features/marketing/company-as-code/code-panel';
import {
  change,
  definition,
  grep,
  hero,
  portable,
  repo,
  selfImprove,
} from '@/features/marketing/company-as-code/content';
import { CompanyAsCodeHeroVisual } from '@/features/marketing/company-as-code/hero-visual';
import { RepoTree } from '@/features/marketing/company-as-code/repo-tree';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

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
      <CapabilityHero
        eyebrow={hero.eyebrow}
        title={hero.title}
        sub={hero.sub}
        ctaPrimary={hero.ctaPrimary}
        ctaPrimaryHref={hero.ctaPrimaryHref}
        ctaSecondary={hero.ctaSecondary}
        ctaSecondaryHref={hero.ctaSecondaryHref}
        visual={<CompanyAsCodeHeroVisual />}
      />

      {/* ── 1 · the two files that define the company ───────────────────── */}
      <section id="definition" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={definition.eyebrow}
          title={definition.title}
          description={definition.sub}
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
                  <li
                    key={note.id}
                    className="border-border border-t pt-5 first:border-t-0 first:pt-0"
                  >
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
      <section id="repo" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={repo.eyebrow} title={repo.title} description={repo.sub} />

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
                  <div
                    key={item.id}
                    className="border-border border-t pt-5 first:border-t-0 first:pt-0"
                  >
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
      <section id="grep" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={grep.eyebrow} title={grep.title} description={grep.sub} />

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
      <section id="change" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={change.eyebrow} title={change.title} description={change.sub} />

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
      <section id="self-improve" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={selfImprove.eyebrow}
          title={selfImprove.title}
          description={selfImprove.sub}
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
      <section id="portable" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={portable.eyebrow}
          title={portable.title}
          description={portable.sub}
        />

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
    </div>
  );
}
