'use client';

import {
  CtaSection,
  GridSection,
  HeroSection,
  ListSection,
} from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { MoreProduct, sectionCopy } from '@/features/marketing/v2/product-kit';

const SECTIONS = PAGES.automations;

const hero = sectionCopy(SECTIONS, 'hero');
const twoWays = sectionCopy(SECTIONS, 'two-ways');
const declared = sectionCopy(SECTIONS, 'declared');
const cta = sectionCopy(SECTIONS, 'cta');

export default function Page() {
  return (
    <main className="bg-background">
      {hero && <HeroSection {...hero} eyebrow="Automations" />}
      {/* The real channels surface: where a triggered session's output lands. */}
      {twoWays && (
        <GridSection
          {...twoWays}
          columns={2}
          visual="/images/product/schedules.png"
        />
      )}
      {/* Config rows, not steps — so the rail stays unnumbered. */}
      {declared && <ListSection {...declared} tone="muted" />}
      <MoreProduct current="/v2/automations" />
      {cta && <CtaSection {...cta} />}
    </main>
  );
}
