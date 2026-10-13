'use client';

import { Reveal } from '@/components/home/reveal';
import Link from '@/components/site-link';
import { Button } from '@/components/ui/marketing/button';
import { FaqSection } from '@/features/marketing/faq';
import Hero from '@/features/marketing/hero';
import { HowItWorks } from '@/features/marketing/how-it-work/how-it-works';
import SectionHeader from '@/features/marketing/component/section-header';
import { SectionDivider } from '@/features/marketing/component/public-route-helpers';
import { servicesTeaser, shared } from '@/features/marketing/landing/content';
import { LogoStrip } from '@/features/marketing/landing/logo-strip';
import { TrustSection } from '@/features/marketing/landing/trust-section';
import { UseCaseWheel } from '@/features/marketing/landing/use-case-wheel';
import { GoalBar, SECTION, StoriesSection } from '@/features/marketing/site/blocks';
import {
  ArrowRightIcon,
  BookOpenTextIcon,
  PlugsConnectedIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';

const SHARED_ICONS: Record<'agents' | 'connections' | 'context', Icon> = {
  agents: UsersThreeIcon,
  connections: PlugsConnectedIcon,
  context: BookOpenTextIcon,
};

/**
 * The conversion path, in the order a buyer asks:
 *   1. what is it, and start now (hero)
 *   2. what is it made of (the six layers, one card, linking to /product)
 *   3. does it fit my team (every team; shared, not per person)
 *   4. who already runs on it (stories)
 *   5. can someone do it with us (services)
 *   6. will IT say yes (security), the last questions (FAQ), then start.
 */
export default function Home() {
  return (
    <div className="bg-background relative">
      <Hero />
      <LogoStrip />
      <div id="cta-pill-anchor" aria-hidden className="h-px" />

      {/* 2 · what it is made of: the six layers, one big card */}
      <HowItWorks />

      <SectionDivider />

      {/* 3 · every team, and shared across them */}
      <UseCaseWheel />

      <section id="shared" className={SECTION}>
        <SectionHeader eyebrow={shared.eyebrow} title={shared.title} description={shared.sub} />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {shared.items.map((item, i) => {
            const Icon = SHARED_ICONS[item.id];
            return (
              <Reveal key={item.id} delay={0.04 * i}>
                <div className="border-border bg-card flex h-full flex-col gap-6 rounded-sm border p-8">
                  <span className="bg-muted text-foreground flex size-10 items-center justify-center rounded-sm">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <div className="flex flex-col gap-2">
                    <h3 className="text-foreground text-lg font-medium tracking-tight">{item.title}</h3>
                    <p className="text-muted-foreground text-sm leading-relaxed">{item.body}</p>
                  </div>
                  <div className="mt-auto flex flex-wrap gap-1.5">
                    {item.chips.map((chip) => (
                      <span
                        key={chip}
                        className="border-border text-muted-foreground rounded-sm border px-2 py-1 font-mono text-xs"
                      >
                        {chip}
                      </span>
                    ))}
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      <SectionDivider />

      {/* 4 · who already runs on it */}
      <StoriesSection limit={3} />

      <SectionDivider />

      {/* 5 · or have us do it with you */}
      <section id="services" className={SECTION}>
        <Reveal>
          <div className="border-border bg-card grid overflow-hidden rounded-sm border lg:grid-cols-5">
            <div className="flex flex-col gap-4 p-8 sm:p-12 lg:col-span-3">
              <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                {servicesTeaser.eyebrow}
              </span>
              <h2 className="text-foreground text-2xl font-medium tracking-tight text-balance sm:text-3xl">
                {servicesTeaser.title}
              </h2>
              <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
                {servicesTeaser.sub}
              </p>
              <div className="mt-4">
                <Button size="lg" asChild>
                  <Link href={servicesTeaser.ctaHref}>
                    {servicesTeaser.cta}
                    <ArrowRightIcon className="size-4 shrink-0" />
                  </Link>
                </Button>
              </div>
            </div>
            <div className="border-border bg-muted/40 flex flex-col justify-center gap-6 border-t p-8 sm:p-12 lg:col-span-2 lg:border-t-0 lg:border-l">
              <p className="text-foreground text-5xl font-medium tracking-tight tabular-nums">
                {servicesTeaser.price}
                <span className="text-muted-foreground ml-2 text-base font-normal">
                  {servicesTeaser.per}
                </span>
              </p>
              <ul className="flex flex-col gap-2">
                {servicesTeaser.roles.map((role) => (
                  <li
                    key={role}
                    className="border-border bg-card text-foreground rounded-sm border px-4 py-3 text-sm font-medium"
                  >
                    {role}
                  </li>
                ))}
              </ul>
              <GoalBar />
            </div>
          </div>
        </Reveal>
      </section>

      {/* 6 · will IT say yes, the last questions, then start */}
      <TrustSection />
      <FaqSection />
    </div>
  );
}
