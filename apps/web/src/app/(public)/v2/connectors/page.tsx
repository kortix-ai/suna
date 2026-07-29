'use client';

import {
  CtaSection,
  GridSection,
  HeroSection,
  SplitSection,
} from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { MoreProduct, sectionCopy } from '@/features/marketing/v2/product-kit';

const SECTIONS = PAGES.connectors;

const hero = sectionCopy(SECTIONS, 'hero');
const howReachWorks = sectionCopy(SECTIONS, 'how-reach-works');
const contextInOut = sectionCopy(SECTIONS, 'context-in-out');
const cta = sectionCopy(SECTIONS, 'cta');

export default function Page() {
  return (
    <main className="bg-background">
      {hero && <HeroSection {...hero} eyebrow="Connectors" />}
      {howReachWorks && <GridSection {...howReachWorks} columns={2} tone="muted" />}
      {contextInOut && <SplitSection {...contextInOut} reversed />}
      <MoreProduct current="/v2/connectors" />
      {cta && <CtaSection {...cta} />}
    </main>
  );
}
