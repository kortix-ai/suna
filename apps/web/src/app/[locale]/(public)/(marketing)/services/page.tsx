'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import { SectionDivider } from '@/features/marketing/component/public-route-helpers';
import SectionHeader from '@/features/marketing/component/section-header';
import { faq, fit, goal, hero, how, offer } from '@/features/marketing/services/content';
import { GoalBar, SECTION, StoriesSection } from '@/features/marketing/site/blocks';
import { cn } from '@/lib/utils';
import { CheckIcon, MinusIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** Hairlines for the 4-up steps grid that reflows 1 → 2 → 4 columns. */
const GRID_4_RULES = [
  '',
  'border-t sm:border-t-0 sm:border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t sm:border-l lg:border-t-0',
] as const;

/** The hero scene: the two people, and the share of work agents carry. */
function TeamVisual(): ReactNode {
  return (
    <div className="border-border bg-card w-full max-w-lg rounded-sm border p-6 sm:p-8">
      <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
        {offer.eyebrow}
      </p>
      <p className="text-foreground mt-4 text-5xl font-medium tracking-tight tabular-nums">
        {offer.price}
        <span className="text-muted-foreground ml-2 text-lg font-normal">{offer.per}</span>
      </p>
      <ul className="mt-6 flex flex-col gap-2">
        {offer.roles.map((r) => (
          <li
            key={r.id}
            className="border-border text-foreground flex items-center justify-between rounded-sm border px-4 py-3 text-sm font-medium"
          >
            {r.role}
            <span className="text-muted-foreground font-mono text-xs">full time</span>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <GoalBar />
      </div>
    </div>
  );
}

/**
 * `/services` — the forward deployed team. Copy, decisions and the accuracy
 * gate: `features/marketing/services/content.ts`.
 */
export default function ServicesPage(): ReactNode {
  const openDemo = useRequestDemo();
  return (
    <div className="bg-background relative">
      <CapabilityHero
        eyebrow={hero.eyebrow}
        title={hero.title}
        sub={hero.sub}
        ctaPrimary={hero.ctaPrimary}
        onCtaPrimaryClick={() => openDemo()}
        ctaSecondary={hero.ctaSecondary}
        ctaSecondaryHref={hero.ctaSecondaryHref}
        visual={<TeamVisual />}
      />

      {/* ── the offer ─────────────────────────────────────────────────────── */}
      <section id="team" className={cn(SECTION, 'scroll-mt-20')}>
        <SectionHeader eyebrow={offer.eyebrow} title={offer.title} description={offer.note} />
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          <Reveal className="lg:col-span-1">
            <div className="border-border bg-card flex h-full flex-col justify-between gap-8 rounded-sm border p-8">
              <div>
                <p className="text-foreground text-6xl font-medium tracking-tight tabular-nums">
                  {offer.price}
                </p>
                <p className="text-muted-foreground mt-2 text-base">{offer.per}</p>
              </div>
              <Button size="lg" className="w-full active:scale-[0.97]" onClick={() => openDemo()}>
                {offer.cta}
              </Button>
            </div>
          </Reveal>
          {offer.roles.map((r, i) => (
            <Reveal key={r.id} delay={0.04 * (i + 1)}>
              <div className="border-border bg-card flex h-full flex-col gap-4 rounded-sm border p-8">
                <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
                  {`0${i + 1}`}
                </p>
                <h3 className="text-foreground text-xl font-medium tracking-tight">{r.role}</h3>
                <p className="text-muted-foreground text-base leading-relaxed">{r.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.1}>
          <ul className="border-border bg-card mt-4 grid gap-x-8 gap-y-3 rounded-sm border p-8 sm:grid-cols-2">
            {offer.includes.map((item) => (
              <li key={item} className="text-foreground flex items-start gap-3 text-sm leading-relaxed">
                <CheckIcon className="text-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── how it works ──────────────────────────────────────────────────── */}
      <section id="how" className={cn(SECTION, 'scroll-mt-20')}>
        <SectionHeader eyebrow={how.eyebrow} title={how.title} description={how.sub} />
        <Reveal delay={0.06}>
          <ol className="border-border bg-card mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
            {how.steps.map((step, i) => (
              <li key={step.n} className={cn('border-border flex flex-col p-6 sm:p-8', GRID_4_RULES[i])}>
                <span className="text-muted-foreground font-mono text-xs tracking-widest tabular-nums">
                  {step.n}
                </span>
                <h3 className="text-foreground mt-6 text-xl font-medium tracking-tight">{step.title}</h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── the goal ──────────────────────────────────────────────────────── */}
      <section id="goal" className={cn(SECTION, 'scroll-mt-20')}>
        <SectionHeader eyebrow={goal.eyebrow} title={goal.title} description={goal.sub} />
        <Reveal delay={0.06}>
          <div className="border-border bg-card mt-10 rounded-sm border p-8">
            <GoalBar />
            <div className="mt-8 grid gap-8 sm:grid-cols-2">
              {[goal.agents, goal.people].map((side) => (
                <div key={side.label}>
                  <p className="text-foreground text-base font-medium">
                    {side.share}% {side.label}
                  </p>
                  <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{side.body}</p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── who it is for ─────────────────────────────────────────────────── */}
      <section id="fit" className={cn(SECTION, 'scroll-mt-20')}>
        <SectionHeader eyebrow={fit.eyebrow} title={fit.title} description={fit.sub} />
        <Reveal delay={0.06}>
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {[
              { id: 'yes', items: fit.yes, Icon: CheckIcon, tone: 'text-foreground' },
              { id: 'no', items: fit.no, Icon: MinusIcon, tone: 'text-muted-foreground' },
            ].map(({ id, items, Icon, tone }) => (
              <ul key={id} className="border-border bg-card flex flex-col gap-4 rounded-sm border p-8">
                {items.map((item) => (
                  <li key={item} className={cn('flex items-start gap-3 text-base leading-relaxed', tone)}>
                    <Icon className="mt-1 size-4 shrink-0" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      <StoriesSection limit={3} />

      <SectionDivider />

      {/* ── questions ─────────────────────────────────────────────────────── */}
      <section id="faq" className={SECTION}>
        <SectionHeader eyebrow={faq.eyebrow} title={faq.title} />
        <Reveal delay={0.06}>
          <dl className="border-border bg-card mt-10 overflow-hidden rounded-sm border">
            {faq.items.map((item, i) => (
              <div
                key={item.id}
                className={cn('border-border grid gap-2 px-6 py-5 sm:grid-cols-12 sm:gap-8 sm:px-8', i > 0 && 'border-t')}
              >
                <dt className="text-foreground text-base font-medium sm:col-span-5">{item.q}</dt>
                <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-7">{item.a}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>
    </div>
  );
}
