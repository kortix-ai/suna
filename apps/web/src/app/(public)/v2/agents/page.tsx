'use client';

import {
  CtaSection,
  HeroSection,
  ListSection,
  SplitSection,
} from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { MoreProduct, sectionCopy } from '@/features/marketing/v2/product-kit';

const SECTIONS = PAGES.agents;

const hero = sectionCopy(SECTIONS, 'hero');
const anatomy = sectionCopy(SECTIONS, 'anatomy');
const harness = sectionCopy(SECTIONS, 'harness');
const cta = sectionCopy(SECTIONS, 'cta');

export default function Page() {
  return (
    <main className="bg-background">
      {hero && <HeroSection {...hero} eyebrow="Agents" />}
      {/* "Six things make up an agent" reads as a count, so the anatomy is numbered. */}
      {anatomy && <ListSection {...anatomy} numbered tone="muted" />}
      {harness && <SplitSection {...harness} reversed />}
      <MoreProduct current="/v2/agents" />
      {cta && <CtaSection {...cta} />}
    </main>
  );
}
