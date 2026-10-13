'use client';

import { Reveal } from '@/components/home/reveal';
import { AgentComputerHeroVisual } from '@/features/marketing/agent-computer/hero-visual';
import { RepoTree } from '@/features/marketing/agents-and-skills/repo-tree';
import { ScheduleTable } from '@/features/marketing/automations/schedule-table';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import { RowList, SectionDivider } from '@/features/marketing/component/public-route-helpers';
import SectionHeader from '@/features/marketing/component/section-header';
import { ConnectorsHeroVisual } from '@/features/marketing/connectors/hero-visual';
import { build, hero, parts } from '@/features/marketing/product/content';
import { PermissionMatrix } from '@/features/marketing/security-page/permission-matrix';
import { SECTION } from '@/features/marketing/site/blocks';
import { KORTIX_CLI_INSTALL_COMMAND } from '@/lib/kortix-cli';
import { cn } from '@/lib/utils';
import Link from '@/components/site-link';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { Fragment, type ReactNode } from 'react';

/** One drawn visual per part, in the order of `parts`. No screenshots. */
const VISUALS: Record<(typeof parts)[number]['id'], () => ReactNode> = {
  agents: RepoTree,
  connect: ConnectorsHeroVisual,
  automate: ScheduleTable,
  control: PermissionMatrix,
};

/**
 * `/product` — the AI Operating System on one page, in four parts. The nav's
 * Product menu links to each part's anchor. Copy and its accuracy gate:
 * `features/marketing/product/content.ts`.
 */
export default function ProductPage(): ReactNode {
  return (
    <div className="bg-background relative">
      <CapabilityHero {...hero} visual={<AgentComputerHeroVisual />} />

      {parts.map((part, i) => {
        const Visual = VISUALS[part.id];
        return (
          <Fragment key={part.id}>
            {i > 0 ? <SectionDivider /> : null}
            <section id={part.id} className={cn(SECTION, 'scroll-mt-20')}>
              <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
                <div className={cn('flex flex-col gap-8', i % 2 === 1 && 'lg:order-2')}>
                  <SectionHeader eyebrow={part.eyebrow} title={part.title} description={part.sub} />
                  <Reveal delay={0.06}>
                    <RowList rows={part.points} />
                  </Reveal>
                </div>
                <Reveal delay={0.08} className="lg:sticky lg:top-24">
                  <Visual />
                </Reveal>
              </div>
            </section>
          </Fragment>
        );
      })}

      <SectionDivider />

      <section id="developers" className={cn(SECTION, 'scroll-mt-20')}>
        <div className="grid items-end gap-10 lg:grid-cols-2">
          <SectionHeader eyebrow={build.eyebrow} title={build.title} description={build.sub} />
          <Reveal delay={0.06}>
            <div className="flex flex-col gap-4">
              {/* kortix.com's own page: the canonical installer, never the
                  deployment-aware hook (deployment-cli-install-surfaces.test). */}
              <pre className="border-border bg-card text-foreground overflow-x-auto rounded-sm border p-5 font-mono text-sm">
                <span className="text-muted-foreground">$ </span>
                {KORTIX_CLI_INSTALL_COMMAND}
              </pre>
              <div className="border-border bg-card grid grid-cols-3 overflow-hidden rounded-sm border">
                {build.items.map((item, j) => (
                  <div key={item.id} className={cn('border-border p-5', j > 0 && 'border-l')}>
                    <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
                      {item.k}
                    </p>
                    <p className="text-foreground mt-3 font-mono text-sm">{item.v}</p>
                  </div>
                ))}
              </div>
              <Link
                href={build.ctaHref}
                className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
              >
                {build.cta}
                <ArrowRightIcon className="size-3.5" aria-hidden />
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
