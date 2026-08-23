import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@/components/ui/separator';
import { CodePanel } from '@/features/marketing/agent-computer/code-panel';
import {
  back,
  commands,
  connect,
  custom,
  hero,
  rules,
  surfaces,
  thread,
} from '@/features/marketing/channels/content';
import { SurfaceTable } from '@/features/marketing/channels/surface-table';
import { ThreadMock } from '@/features/marketing/channels/thread-mock';
import { ChannelsHeroVisual } from '@/features/marketing/channels/hero-visual';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

function SectionDivider(): ReactNode {
  return (
    <div className="mx-auto max-w-7xl px-6">
      <Separator />
    </div>
  );
}

/**
 * `/channels` — reaching the product from the thread people already sit in.
 *
 * Copy lives in `features/marketing/channels/content.ts`, whose header carries
 * the accuracy gate that governs this page. The short version: Slack is the one
 * live channel, Teams is off unless the operator turns it on, and email
 * are experimental, and Telegram / WhatsApp / SMS are not channels at all.
 * Re-verify against `packages/manifest-schema/src/constants.ts` before adding a
 * surface to this page.
 */
export default function ChannelsPage(): ReactNode {
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
        visual={<ChannelsHeroVisual />}
      />

      {/* ── 1 · the four platforms, and the truth about each ────────────── */}
      <section id="surfaces" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={surfaces.eyebrow}
          title={surfaces.title}
          description={surfaces.sub}
        />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <SurfaceTable />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="border-border mt-6 border-t pt-4">
            <h3 className="text-foreground text-sm font-medium">{surfaces.notChannels.title}</h3>
            <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-relaxed">
              {surfaces.notChannels.body}
            </p>
            <Link
              href={surfaces.notChannels.linkHref}
              className="text-foreground hover:text-muted-foreground mt-3 inline-block font-mono text-xs tracking-wider uppercase transition-colors"
            >
              {surfaces.notChannels.linkLabel}
            </Link>
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 2 · a thread is a session ───────────────────────────────────── */}
      <section id="thread" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={thread.eyebrow} title={thread.title} description={thread.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="lg:col-span-7">
            <div className="h-full">
              <ThreadMock />
            </div>
          </Reveal>

          <Reveal delay={0.1} className="lg:col-span-5">
            <ol className="border-border bg-card grid h-full overflow-hidden rounded-sm border">
              {thread.steps.map((step, i) => (
                <li
                  key={step.n}
                  className={cn('border-border flex flex-col p-6', i > 0 && 'border-t')}
                >
                  <span className="text-muted-foreground/45 font-mono text-xs tracking-widest tabular-nums">
                    {step.n}
                  </span>
                  <h3 className="text-foreground mt-3 text-base leading-tight font-medium">
                    {step.title}
                  </h3>
                  <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{step.body}</p>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>

        <Reveal delay={0.14}>
          <p className="border-border text-muted-foreground mt-6 max-w-3xl border-t pt-4 text-sm leading-relaxed">
            {thread.footnote}
          </p>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 3 · connecting it, honestly ─────────────────────────────────── */}
      <section id="connect" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={connect.eyebrow} title={connect.title} description={connect.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <CodePanel title={connect.shell.title} lines={connect.shell.lines} lang="sh" />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {connect.notes.map((note) => (
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

      {/* ── 4 · what comes back into the thread ─────────────────────────── */}
      <section id="round-trip" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={back.eyebrow} title={back.title} description={back.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {back.cards.map((card) => (
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

        <Reveal delay={0.1}>
          <p className="border-border text-muted-foreground mt-6 max-w-3xl border-t pt-4 text-sm leading-relaxed">
            {back.footnote}
          </p>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 5 · driving the project from the thread ─────────────────────── */}
      <section id="commands" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={commands.eyebrow}
          title={commands.title}
          description={commands.sub}
        />

        <Reveal delay={0.06}>
          <div className="border-border bg-card mt-10 overflow-hidden rounded-sm border">
            <div className="border-border hidden border-b sm:grid sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-4">
              {commands.columns.map((column, i) => (
                <span
                  key={column}
                  className={cn(
                    'text-muted-foreground font-mono text-[10px] tracking-widest uppercase',
                    i === 0 ? 'sm:col-span-5' : 'sm:col-span-7',
                  )}
                >
                  {column}
                </span>
              ))}
            </div>

            <dl>
              {commands.rows.map((row, i) => (
                <div
                  key={row.cmd}
                  className={cn(
                    'border-border grid gap-2 px-6 py-5 sm:grid-cols-12 sm:gap-8 sm:px-8',
                    i > 0 && 'border-t',
                  )}
                >
                  <dt className="text-foreground font-mono text-[12.5px] sm:col-span-5">
                    {row.cmd}
                  </dt>
                  <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-7">
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-6">
            <h3 className="text-foreground text-sm font-medium">{commands.policy.title}</h3>
            <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {commands.policy.values.map((value) => (
                <div key={value.k} className="border-border border-t pt-4">
                  <dt className="text-foreground font-mono text-xs">{value.k}</dt>
                  <dd className="text-muted-foreground mt-2 text-sm leading-relaxed">{value.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 6 · the walls do not move because it is chat ────────────────── */}
      <section id="rules" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={rules.eyebrow} title={rules.title} description={rules.sub} />

        <Reveal delay={0.06}>
          <dl className="border-border bg-card mt-10 overflow-hidden rounded-sm border">
            {rules.rows.map((row, i) => (
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

      {/* ── 7 · the gap, named out loud ─────────────────────────────────── */}
      <section id="custom" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={custom.eyebrow} title={custom.title} description={custom.sub} />

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="lg:col-span-7">
            <CodePanel title={custom.yaml.title} lines={custom.yaml.lines} lang="yaml" />
          </Reveal>

          <Reveal delay={0.1} className="lg:col-span-5">
            <div className="grid h-full gap-4">
              {custom.points.map((point) => (
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
          <Button size="lg" variant="secondary" asChild className="mt-6 w-fit">
            <Link href={custom.ctaHref}>{custom.ctaLabel}</Link>
          </Button>
        </Reveal>
      </section>
    </div>
  );
}
