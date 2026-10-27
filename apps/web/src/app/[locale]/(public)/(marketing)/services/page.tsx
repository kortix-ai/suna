'use client';

import Link from '@/components/site-link';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { DitherGlyph } from '@/features/marketing/kit/dither-glyph';
import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, KeyRows, PageFrame, PageHero, SpecGrid } from '@/features/marketing/kit/page-frame';
import {
  closing,
  execution,
  hero,
  offerings,
  ownership,
  specs,
  strategy,
  team,
  why,
} from '@/features/marketing/services/summary';
import { useState } from 'react';

/**
 * `/services`: AI Restructuring, the forward deployed team. The other half of
 * the site from the AI OS pages. Copy and its accuracy gate:
 * `features/marketing/services/summary.ts`.
 *
 * Layout matches /enterprise: the landing page's frame, `FeatureSplit`
 * sections, dither art in the hero. Every "Book a call" opens the demo modal.
 *
 * TODO(idea): the hero has no real artifact (kortix-brand magic_trick.md).
 * The idea it lacks is a real adoption report or roadmap excerpt.
 */

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-services-call';

export default function ServicesPage() {
  const [calOpen, setCalOpen] = useState(false);
  const bookCall = (
    <MarketingButton size="md" className="hit-area-y-1" onClick={() => setCalOpen(true)}>
      Book a call
    </MarketingButton>
  );

  return (
    <>
      <PageFrame>
        <section id="hero">
          <PageHero
            title={hero.title}
            titleMuted={hero.titleMuted}
            sub={hero.sub}
            aside={<DitherGlyph src="/media/services/team.svg" className="aspect-[15/11] w-80 xl:w-88" />}
            actions={
              <>
                <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
                  <Link href="/">See the AI OS</Link>
                </MarketingButton>
                {bookCall}
              </>
            }
          />
          <Band>
            <SpecGrid items={specs} cols="lg:grid-cols-4" />
          </Band>
        </section>

        <FeatureSplit id="strategy" {...strategy} cols="lg:grid-cols-4" />

        <Block id="execution">
          <Heading title={execution.title} titleMuted={execution.titleMuted} sub={execution.sub} />
          <Band className="mt-12">
            <CellGrid items={execution.items} cols="lg:grid-cols-3" />
          </Band>
        </Block>

        <FeatureSplit id="team" {...team} cols="lg:grid-cols-2" />

        <Block id="why">
          <Heading title={why.title} titleMuted={why.titleMuted} />
          <div className="mt-8">
            <KeyRows rows={why.rows} />
          </div>
        </Block>

        <Block id="offerings">
          <Heading title={offerings.title} titleMuted={offerings.titleMuted} />
          <Band className="mt-12">
            <CellGrid items={offerings.items} cols="lg:grid-cols-3" />
          </Band>
        </Block>

        <FeatureSplit id="ownership" {...ownership} />

        <Block id="start">
          <Heading title={closing.title} titleMuted={closing.titleMuted} actions={bookCall} />
        </Block>
      </PageFrame>

      <DemoQualifierModal
        open={calOpen}
        onOpenChange={setCalOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="services"
      />
    </>
  );
}
