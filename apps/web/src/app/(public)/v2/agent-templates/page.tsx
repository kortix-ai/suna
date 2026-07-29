'use client';

import {
  CtaSection,
  GridSection,
  HeroSection,
  SplitSection,
} from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { MoreProduct, sectionCopy } from '@/features/marketing/v2/product-kit';

const SECTIONS = PAGES['agent-templates'];

const hero = sectionCopy(SECTIONS, 'hero');
const popular = sectionCopy(SECTIONS, 'popular');
const yoursAfterInstall = sectionCopy(SECTIONS, 'yours-after-install');
const cta = sectionCopy(SECTIONS, 'cta');

export default function Page() {
  return (
    <main className="bg-background">
      {hero && <HeroSection {...hero} eyebrow="Agent templates" />}
      {/* A gallery of installable agents, so the six stay as cards. */}
      {popular && <GridSection {...popular} columns={3} tone="muted" />}
      {yoursAfterInstall && <SplitSection {...yoursAfterInstall} reversed />}
      <MoreProduct current="/v2/agent-templates" />
      {cta && <CtaSection {...cta} />}
    </main>
  );
}
