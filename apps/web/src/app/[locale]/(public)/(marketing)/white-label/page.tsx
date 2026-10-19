import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { CodePanel } from '@/features/marketing/code-panel';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import { RowList, SectionDivider } from '@/features/marketing/component/public-route-helpers';
import SectionHeader from '@/features/marketing/component/section-header';
import {
  AGREEMENT_URL,
  closing,
  CUSTOM_TERMS_URL,
  deal,
  ENV_LINES,
  hero,
  platinum,
  scenarios,
  SIGN_URL,
  steps,
  terms,
} from '@/features/marketing/white-label/content';
import { ArrowRightIcon } from '@/lib/icons/ssr';
import type { ReactNode } from 'react';

function Bullets({ title, items }: { title: string; items: readonly string[] }): ReactNode {
  return (
    <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8">
      <h3 className="text-foreground text-lg leading-tight font-medium">{title}</h3>
      <ul className="mt-6 space-y-4">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3">
            <span
              aria-hidden
              className="bg-muted-foreground mt-2 size-1.5 shrink-0 rounded-full"
            />
            <span className="text-muted-foreground text-sm leading-relaxed">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `/white-label` — build your own product on Kortix, on Platinum.dev compute.
 *
 * Copy lives in `features/marketing/white-label/content.ts`, and that file's
 * header lists what the page may and may not claim. The binding text is
 * `WHITE-LABEL-LICENSE.md`; the page restates it and links it.
 *
 * Unlisted on purpose: no nav, footer or menu links here.
 */
export default function WhiteLabelPage(): ReactNode {
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
        visual={
          <div className="w-full max-w-xl">
            <CodePanel title={hero.envTitle} lines={ENV_LINES} lang="sh" />
          </div>
        }
      />

      {/* ── 1 · what you can build ──────────────────────────────────────── */}
      <section id="scenarios" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={scenarios.eyebrow}
          title={scenarios.title}
          description={scenarios.sub}
        />
        <Reveal delay={0.06}>
          <div className="mt-10">
            <RowList rows={scenarios.rows} />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 2 · the deal ────────────────────────────────────────────────── */}
      <section id="deal" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={deal.eyebrow} title={deal.title} description={deal.sub} />
        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Bullets title={deal.get.title} items={deal.get.items} />
            <Bullets title={deal.commit.title} items={deal.commit.items} />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 3 · Platinum.dev ────────────────────────────────────────────── */}
      <section id="platinum" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader
          eyebrow={platinum.eyebrow}
          title={platinum.title}
          description={platinum.sub}
        />
        <Reveal delay={0.06}>
          <div className="mt-10">
            <RowList rows={platinum.rows} />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 4 · how it works ────────────────────────────────────────────── */}
      <section id="how-it-works" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={steps.eyebrow} title={steps.title} description={steps.sub} />
        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Reveal delay={0.06} className="lg:col-span-7">
            <ol className="border-border bg-card overflow-hidden rounded-sm border">
              {steps.items.map((item, i) => (
                <li
                  key={item.n}
                  className={i > 0 ? 'border-border border-t p-6 sm:p-7' : 'p-6 sm:p-7'}
                >
                  <span className="text-muted-foreground font-mono text-xs tracking-widest tabular-nums">
                    {item.n}
                  </span>
                  <h3 className="text-foreground mt-4 text-base leading-tight font-medium">
                    {item.k}
                  </h3>
                  <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{item.v}</p>
                </li>
              ))}
            </ol>
          </Reveal>
          <Reveal delay={0.1} className="lg:col-span-5">
            <CodePanel title={steps.panelTitle} lines={ENV_LINES} lang="sh" />
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 5 · the agreement ───────────────────────────────────────────── */}
      <section id="agreement" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={terms.eyebrow} title={terms.title} description={terms.sub} />
        <Reveal delay={0.06}>
          <div className="mt-10">
            <RowList rows={terms.rows} />
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <Button variant="link" asChild>
            <a href={AGREEMENT_URL}>{terms.readLabel}</a>
          </Button>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 6 · sign ────────────────────────────────────────────────────── */}
      <section id="sign" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={closing.eyebrow} title={closing.title} description={closing.sub} />
        <Reveal delay={0.06}>
          <div className="mt-10 flex flex-wrap items-center gap-2 sm:gap-3">
            <Button size="lg" asChild>
              <a href={SIGN_URL}>{closing.primaryLabel}</a>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href={AGREEMENT_URL}>{closing.secondaryLabel}</a>
            </Button>
            <Button size="lg" variant="ghost" className="gap-1.5" asChild>
              <a href={CUSTOM_TERMS_URL}>
                {closing.tertiaryLabel}
                <ArrowRightIcon className="size-4" aria-hidden />
              </a>
            </Button>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
